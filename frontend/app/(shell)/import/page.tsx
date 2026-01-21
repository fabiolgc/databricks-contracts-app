"use client"

import { useState } from "react"
import { Upload, CheckCircle2, XCircle, Loader2, ChevronLeft, ChevronRight } from "lucide-react"
import { toast } from "sonner"

type FileStatus = "pending" | "uploading" | "success" | "error" | "skipped"

interface FileWithStatus {
  id: string
  file: File
  name: string
  size: number
  status: FileStatus
  progress: number
  error?: string
}

const FILES_PER_PAGE = 5

// Extend Window interface for overwrite decision callback
declare global {
  interface Window {
    __overwriteResolve?: (decision: "overwrite" | "overwrite_all" | "skip") => void
  }
}

export default function ImportPage() {
  const [isDragging, setIsDragging] = useState(false)
  const [files, setFiles] = useState<FileWithStatus[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [showOverwriteDialog, setShowOverwriteDialog] = useState(false)
  const [currentConflictFile, setCurrentConflictFile] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    
    const droppedFiles = Array.from(e.dataTransfer.files).filter(
      file => file.type === "application/pdf"
    )
    
    if (droppedFiles.length > 0) {
      addFilesToList(droppedFiles)
    }
  }

  function addFilesToList(newFiles: File[]) {
    const existingFileNames = new Set(files.map(f => f.name))
    const duplicates: string[] = []
    const filesToAdd: File[] = []

    newFiles.forEach(file => {
      if (existingFileNames.has(file.name)) {
        duplicates.push(file.name)
      } else {
        filesToAdd.push(file)
      }
    })

    // Show notification for duplicates
    if (duplicates.length > 0) {
      if (duplicates.length === 1) {
        toast.warning(`Arquivo já está na lista: ${duplicates[0]}`, {
          duration: 7000,
        })
      } else if (duplicates.length <= 3) {
        toast.warning(
          <div>
            <p className="font-medium mb-1">Arquivos já estão na lista:</p>
            <ul className="text-sm space-y-0.5">
              {duplicates.map((name, i) => (
                <li key={i}>• {name}</li>
              ))}
            </ul>
          </div>,
          { duration: 8000 }
        )
      } else {
        toast.warning(
          `${duplicates.length} arquivos duplicados não foram adicionados`,
          {
            description: `Arquivos já existentes: ${duplicates.slice(0, 2).join(", ")}...`,
            duration: 7000,
          }
        )
      }
    }

    // Add only non-duplicate files
    if (filesToAdd.length > 0) {
      const filesWithStatus: FileWithStatus[] = filesToAdd.map(file => ({
        id: crypto.randomUUID(),
        file: file,
        name: file.name,
        size: file.size,
        status: "pending" as FileStatus,
        progress: 0,
      }))

      setFiles(prev => {
        const newFiles = [...prev, ...filesWithStatus]
        // Reset to page 1 if adding files would make current page empty
        const totalPages = Math.ceil(newFiles.length / FILES_PER_PAGE)
        if (currentPage > totalPages) {
          setCurrentPage(totalPages)
        }
        return newFiles
      })

      // Show success message
      if (filesToAdd.length === 1) {
        toast.success(`1 arquivo adicionado à lista`, {
          duration: 5000,
        })
      } else {
        toast.success(`${filesToAdd.length} arquivos adicionados à lista`, {
          duration: 5000,
        })
      }

      // Highlight newly added files temporarily
      if (filesWithStatus.length > 0) {
        setTimeout(() => {
          filesWithStatus.forEach(file => {
            const element = document.querySelector(`[data-file-id="${file.id}"]`)
            if (element) {
              element.classList.add('animate-pulse', 'bg-green-50')
              setTimeout(() => {
                element.classList.remove('animate-pulse', 'bg-green-50')
              }, 1500)
            }
          })
        }, 100)
      }
    } else if (duplicates.length > 0) {
      // All files were duplicates
      console.log(`⚠️ All ${duplicates.length} file(s) were duplicates`)
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const selectedFiles = e.target.files
    if (selectedFiles) {
      const pdfFiles = Array.from(selectedFiles).filter(
        file => file.type === "application/pdf"
      )
      if (pdfFiles.length > 0) {
        addFilesToList(pdfFiles)
      }
    }
    // Reset input to allow selecting the same files again
    e.target.value = ""
  }

  async function uploadFile(file: FileWithStatus, shouldOverwrite: boolean = false) {
    // Update status to uploading
    setFiles(prev =>
      prev.map(f =>
        f.id === file.id ? { ...f, status: "uploading", progress: 0 } : f
      )
    )

    try {
      const formData = new FormData()
      formData.append("file", file.file)
      formData.append("overwrite", shouldOverwrite.toString())

      console.log(`📤 Uploading: ${file.name}${shouldOverwrite ? " [OVERWRITE]" : ""}`)

      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      })

      const result = await response.json()

      // File exists - need confirmation
      if (response.status === 409 && result.fileExists) {
        console.log(`⚠️ File exists: ${file.name}`)
        setFiles(prev =>
          prev.map(f =>
            f.id === file.id ? { ...f, status: "pending", progress: 0 } : f
          )
        )
        return "conflict"
      }

      if (response.ok && result.success) {
        console.log(`✅ Upload successful: ${file.name}`)
        setFiles(prev =>
          prev.map(f =>
            f.id === file.id
              ? { ...f, status: "success", progress: 100 }
              : f
          )
        )
        return "success"
      } else {
        throw new Error(result.error || "Upload failed")
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Upload failed"
      console.error(`❌ Error uploading ${file.name}:`, errorMessage)

      setFiles(prev =>
        prev.map(f =>
          f.id === file.id
            ? { ...f, status: "error", error: errorMessage, progress: 0 }
            : f
        )
      )
      return "error"
    }
  }

  async function handleImport() {
    if (files.length === 0) return

    setIsUploading(true)
    let localOverwriteAll = false
    let successCount = 0
    let errorCount = 0
    let skippedCount = 0

    console.log(`🚀 Starting upload of ${files.length} file(s)`)

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (file.status === "success" || file.status === "skipped") continue

      // Navigate to the page where this file is located
      const filePageNumber = Math.floor(i / FILES_PER_PAGE) + 1
      if (filePageNumber !== currentPage) {
        setCurrentPage(filePageNumber)
        // Small delay to allow page transition
        await new Promise(resolve => setTimeout(resolve, 300))
      }

      const result = await uploadFile(file, localOverwriteAll)

      if (result === "conflict") {
        // Show dialog and wait for user decision
        setCurrentConflictFile(file.name)
        setShowOverwriteDialog(true)

        // Wait for user decision
        const decision = await new Promise<"overwrite" | "overwrite_all" | "skip">((resolve) => {
          const checkDecision = setInterval(() => {
            if (!showOverwriteDialog) {
              clearInterval(checkDecision)
            }
          }, 100)

          // Store resolve function for dialog handlers
          window.__overwriteResolve = resolve
        })

        setShowOverwriteDialog(false)
        setCurrentConflictFile(null)

        if (decision === "overwrite" || decision === "overwrite_all") {
          if (decision === "overwrite_all") {
            localOverwriteAll = true
            console.log("🔄 Overwrite ALL enabled - will not ask again")
          }
          // Retry with overwrite
          const retryResult = await uploadFile(file, true)
          if (retryResult === "success") successCount++
          else if (retryResult === "error") errorCount++
        } else {
          // Skip this file
          console.log(`⏭️ Skipping file: ${file.name}`)
          setFiles(prev =>
            prev.map(f =>
              f.id === file.id ? { ...f, status: "skipped" } : f
            )
          )
          skippedCount++
        }
      } else if (result === "success") {
        successCount++
      } else if (result === "error") {
        errorCount++
      }
    }

    setIsUploading(false)

    // Sort files: success/error/skipped at end, pending at start
    setFiles(prev => {
      const sorted = [...prev].sort((a, b) => {
        const order = { pending: 0, uploading: 1, success: 2, error: 3, skipped: 4 }
        return order[a.status] - order[b.status]
      })
      return sorted
    })

    // Show summary toast
    if (errorCount === 0 && skippedCount === 0 && successCount > 0) {
      toast.success(`${successCount} arquivo(s) importado(s) com sucesso!`, {
        duration: 6000,
      })
    } else if (successCount > 0) {
      const parts = [`${successCount} importado(s)`]
      if (skippedCount > 0) parts.push(`${skippedCount} ignorado(s)`)
      if (errorCount > 0) parts.push(`${errorCount} com erro`)
      
      toast.warning(parts.join(', '), {
        duration: 8000,
      })
    } else if (errorCount > 0 || skippedCount > 0) {
      const parts = []
      if (errorCount > 0) parts.push(`${errorCount} com erro`)
      if (skippedCount > 0) parts.push(`${skippedCount} ignorado(s)`)
      
      toast.warning(parts.join(', '), {
        duration: 7000,
      })
    }

    console.log(`📊 Upload complete: ${successCount} success, ${errorCount} errors, ${skippedCount} skipped`)
  }

  function handleOverwriteDecision(decision: "overwrite" | "overwrite_all" | "skip") {
    if (window.__overwriteResolve) {
      window.__overwriteResolve(decision)
      delete window.__overwriteResolve
    }
    setShowOverwriteDialog(false)
  }

  return (
    <>
      {/* Overwrite Confirmation Dialog */}
      {showOverwriteDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full">
            <h3 className="text-xl font-bold text-[#1B1B1D] mb-2">
              Arquivo já existe
            </h3>
            <p className="text-base text-gray-600 mb-2">
              O arquivo
            </p>
            <p className="text-sm font-medium text-[#1B1B1D] bg-gray-50 p-3 rounded-lg mb-4 break-words">
              {currentConflictFile}
            </p>
            <p className="text-base text-gray-600 mb-6">
              já existe no volume. Deseja sobrescrevê-lo?
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => handleOverwriteDecision("overwrite_all")}
                className="w-full px-4 py-2.5 text-sm font-medium text-white bg-[#FF3621] rounded-lg hover:bg-[#FF3621]/90 transition-colors"
              >
                Sobrescrever todos
              </button>
              <button
                onClick={() => handleOverwriteDecision("overwrite")}
                className="w-full px-4 py-2.5 text-sm font-medium text-[#FF3621] bg-red-50 rounded-lg hover:bg-red-100 transition-colors"
              >
                Sobrescrever apenas este
              </button>
              <button
                onClick={() => handleOverwriteDecision("skip")}
                className="w-full px-4 py-2.5 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Pular este arquivo
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-[#1B1B1D]">Importar Documentos</h1>
        <p className="mt-2 text-base text-gray-600">
          Faça upload dos seus contratos em PDF para análise
        </p>
      </div>

      {files.length === 0 && (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`
            border-2 border-dashed rounded-xl p-12 text-center
            transition-all duration-200 cursor-pointer
            ${isDragging 
              ? "border-[#FF3621] bg-red-50 shadow-sm" 
              : "border-gray-300 hover:border-[#FF3621]/50 hover:bg-gray-50"
            }
          `}
        >
          <Upload className="mx-auto h-12 w-12 text-gray-400" />
          <div className="mt-4">
            <label htmlFor="file-upload" className="cursor-pointer">
              <span className="text-base text-[#FF3621] hover:text-[#FF3621]/80 font-medium">
                Clique para selecionar
              </span>
              <span className="text-base text-gray-600"> ou arraste os arquivos aqui</span>
            </label>
            <input
              id="file-upload"
              type="file"
              multiple
              accept=".pdf"
              onChange={handleFileSelect}
              className="hidden"
            />
          </div>
          <p className="mt-2 text-sm text-gray-500">
            Apenas arquivos PDF (máximo 10MB por arquivo)
          </p>
        </div>
      )}

      {files.length > 0 && (() => {
        // Pagination calculations
        const totalPages = Math.ceil(files.length / FILES_PER_PAGE)
        const startIndex = (currentPage - 1) * FILES_PER_PAGE
        const endIndex = startIndex + FILES_PER_PAGE
        const currentFiles = files.slice(startIndex, endIndex)
        
        return (
          <div className="space-y-4">
            {/* Add More Files Button */}
            {!isUploading && (
              <div className="flex justify-center">
                <label htmlFor="file-upload-more" className="cursor-pointer">
                  <div className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-[#FF3621] bg-red-50 border border-[#FF3621]/30 rounded-lg hover:bg-red-100 transition-colors">
                    <Upload className="h-4 w-4" />
                    Adicionar mais arquivos
                  </div>
                  <input
                    id="file-upload-more"
                    type="file"
                    multiple
                    accept=".pdf"
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                </label>
              </div>
            )}

            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-[#1B1B1D]">
                Arquivos Selecionados ({files.length})
              </h3>
              {totalPages > 1 && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                    disabled={currentPage === 1}
                    className="p-1.5 rounded-md text-gray-600 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    aria-label="Página anterior"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="text-sm text-gray-600 font-medium min-w-[80px] text-center">
                    Página {currentPage} de {totalPages}
                  </span>
                  <button
                    onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                    disabled={currentPage === totalPages}
                    className="p-1.5 rounded-md text-gray-600 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    aria-label="Próxima página"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
            <ul className="divide-y divide-gray-200 bg-gray-50/50">
              {currentFiles.map((file) => (
              <li 
                key={file.id} 
                data-file-id={file.id}
                className="px-4 py-4 transition-colors duration-300"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    {/* Status Icon */}
                    <div className="flex-shrink-0">
                      {file.status === "pending" && (
                        <svg className="h-5 w-5 text-[#FF3621]" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
                        </svg>
                      )}
                      {file.status === "uploading" && (
                        <Loader2 className="h-5 w-5 text-[#FF3621] animate-spin" />
                      )}
                      {file.status === "success" && (
                        <CheckCircle2 className="h-5 w-5 text-[#00A972]" />
                      )}
                      {file.status === "error" && (
                        <XCircle className="h-5 w-5 text-red-600" />
                      )}
                      {file.status === "skipped" && (
                        <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                        </svg>
                      )}
                    </div>

                    {/* File Info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[#1B1B1D] truncate">
                        {file.name}
                      </p>
                      <div className="flex items-center gap-2">
                        <p className="text-sm text-gray-500">
                          {(file.size / 1024 / 1024).toFixed(2)} MB
                        </p>
                        {file.status === "uploading" && (
                          <span className="text-xs text-[#FF3621]">
                            Enviando...
                          </span>
                        )}
                        {file.status === "success" && (
                          <span className="text-xs text-[#00A972]">
                            ✓ Concluído
                          </span>
                        )}
                        {file.status === "error" && (
                          <span className="text-xs text-red-600">
                            ✕ {file.error || "Erro"}
                          </span>
                        )}
                        {file.status === "skipped" && (
                          <span className="text-xs text-gray-400">
                            Ignorado
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Action Button */}
                  {(file.status === "pending" || file.status === "error" || file.status === "skipped") && !isUploading && (
                    <button
                      onClick={() => {
                        setFiles(prev => {
                          const newFiles = prev.filter(f => f.id !== file.id)
                          // Adjust page if needed
                          const totalPages = Math.ceil(newFiles.length / FILES_PER_PAGE)
                          if (currentPage > totalPages && totalPages > 0) {
                            setCurrentPage(totalPages)
                          }
                          return newFiles
                        })
                      }}
                      className="text-[#FF3621] hover:text-[#FF3621]/80 text-sm font-medium transition-colors ml-4"
                    >
                      Remover
                    </button>
                  )}
                </div>
              </li>
              ))}
            </ul>
            <div className="px-4 py-4 bg-gray-50 border-t border-gray-200 flex justify-end gap-3">
              {files.every(f => f.status === "success" || f.status === "error" || f.status === "skipped") && files.length > 0 ? (
                <button
                  onClick={() => {
                    setFiles([])
                    setCurrentPage(1)
                  }}
                  className="px-4 py-2 text-sm font-medium text-white bg-[#00A972] rounded-lg hover:bg-[#00A972]/90 transition-colors shadow-sm flex items-center gap-2"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Concluir
                </button>
              ) : (
                <>
                  <button
                    onClick={() => {
                      setFiles([])
                      setCurrentPage(1)
                    }}
                    disabled={isUploading}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={handleImport}
                    disabled={isUploading}
                    className="px-4 py-2 text-sm font-medium text-white bg-[#FF3621] rounded-lg hover:bg-[#FF3621]/90 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    {isUploading && <Loader2 className="h-4 w-4 animate-spin" />}
                    {isUploading
                      ? "Importando..."
                      : `Importar ${files.length} ${files.length === 1 ? "arquivo" : "arquivos"}`
                    }
                  </button>
                </>
              )}
              </div>
            </div>
          </div>
        )
      })()}
    </div>
    </>
  )
}
