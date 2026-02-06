"use client"

import { useState, useEffect, useRef } from "react"
import {
  Bot,
  Send,
  Loader2,
  User,
  FileText,
  Zap,
  Clock,
  ThumbsUp,
  ThumbsDown,
  Copy,
  Check,
  Trash2,
  Settings,
  Plus,
  ChevronDown,
  X,
  Edit2,
  Users,
  HelpCircle,
  ExternalLink,
  AlertCircle
} from "lucide-react"
import { toast } from "sonner"
import { useTranslation } from "@/lib/i18n"

interface Profile {
  id: string
  name: string
  description: string
  system_prompt: string
  is_active: boolean
  created_at?: string
  updated_at?: string
}

interface Diagnostics {
  vector_search_status: string
  vector_search_error: string | null
  index_name: string | null
  llm_status: string
  llm_error: string | null
}

interface Message {
  id: string
  role: "user" | "assistant"
  content: string
  sources?: Source[]
  token_usage?: TokenUsage
  trace_id?: string
  timestamp: Date
  feedback?: "positive" | "negative"
  diagnostics?: Diagnostics
}

interface Source {
  chunk_id: string
  file_name: string
  chunk_index: number
  score: number
  content?: string
}

interface TokenUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

// Example questions for each profile
const PROFILE_EXAMPLES: Record<string, string[]> = {
  buyer: [
    "Este contrato possui cláusula de rescisão sem multa?",
    "Quais são os prazos de entrega previstos nos contratos?",
    "O contrato segue o padrão de cláusulas obrigatórias?",
    "Existe cláusula de reajuste de preços? Qual o índice?",
    "Quais penalidades estão previstas para atraso na entrega?",
    "Liste todas as obrigações do fornecedor neste contrato"
  ],
  analyst: [
    "O produto está coberto pela garantia deste contrato?",
    "Qual é o período de vigência do contrato e quando vence?",
    "Quais são os valores das multas por descumprimento?",
    "O SLA de atendimento está definido? Qual o tempo máximo?",
    "Qual o valor total do contrato e forma de pagamento?",
    "A manutenção preventiva está incluída no escopo?"
  ],
  legal: [
    "Identifique cláusulas potencialmente abusivas",
    "O foro escolhido é adequado para esta operação?",
    "Existe cláusula de limitação de responsabilidade?",
    "O contrato está em conformidade com a LGPD?",
    "Quais são os riscos de renovação automática?",
    "Liste pendências jurídicas que precisam de revisão"
  ],
  default: [
    "Quais contratos estão disponíveis para análise?",
    "Faça um resumo dos principais pontos do contrato",
    "Quais são as partes envolvidas no contrato?",
    "Qual é o objeto principal deste contrato?",
    "Existem anexos ou adendos neste contrato?"
  ]
}

export default function AgentPage() {
  const { t } = useTranslation()
  
  // Profile state
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [selectedProfile, setSelectedProfile] = useState<Profile | null>(null)
  const [isLoadingProfiles, setIsLoadingProfiles] = useState(true)
  const [showProfileDropdown, setShowProfileDropdown] = useState(false)
  const [showProfileModal, setShowProfileModal] = useState(false)
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null)
  const [showExamplesPopover, setShowExamplesPopover] = useState(false)
  
  // Chat state
  const [messages, setMessages] = useState<Message[]>([])
  const [inputMessage, setInputMessage] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  
  // Modal states
  const [showSourcesModal, setShowSourcesModal] = useState(false)
  const [selectedSources, setSelectedSources] = useState<Source[]>([])
  
  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const profileDropdownRef = useRef<HTMLDivElement>(null)
  const examplesRef = useRef<HTMLDivElement>(null)
  
  // Load profiles on mount
  useEffect(() => {
    loadProfiles()
  }, [])
  
  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])
  
  // Close dropdowns on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (profileDropdownRef.current && !profileDropdownRef.current.contains(event.target as Node)) {
        setShowProfileDropdown(false)
      }
      if (examplesRef.current && !examplesRef.current.contains(event.target as Node)) {
        setShowExamplesPopover(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])
  
  async function loadProfiles() {
    setIsLoadingProfiles(true)
    try {
      const response = await fetch("/api/profiles")
      if (!response.ok) throw new Error("Failed to load profiles")
      
      const data = await response.json()
      setProfiles(data.profiles || [])
      
      const activeProfiles = (data.profiles || []).filter((p: Profile) => p.is_active)
      if (activeProfiles.length > 0 && !selectedProfile) {
        setSelectedProfile(activeProfiles[0])
      }
    } catch (error) {
      console.error("Error loading profiles:", error)
      toast.error(t("agent.errors.loadProfiles"))
    } finally {
      setIsLoadingProfiles(false)
    }
  }
  
  async function sendMessage() {
    if (!inputMessage.trim()) {
      toast.warning(t("agent.errors.emptyMessage"))
      return
    }
    
    if (!selectedProfile) {
      toast.warning(t("agent.errors.noProfile"))
      return
    }
    
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: inputMessage.trim(),
      timestamp: new Date()
    }
    
    setMessages(prev => [...prev, userMessage])
    setInputMessage("")
    setIsLoading(true)
    
    try {
      const conversationHistory = messages.map(m => ({
        role: m.role,
        content: m.content
      }))
      
      const response = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMessage.content,
          profile_id: selectedProfile.id,
          conversation_history: conversationHistory
        })
      })
      
      if (!response.ok) {
        throw new Error(`Chat failed: ${response.status}`)
      }
      
      const data = await response.json()
      
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: data.response,
        sources: data.sources,
        token_usage: data.token_usage,
        trace_id: data.trace_id,
        timestamp: new Date(),
        diagnostics: data.diagnostics
      }
      
      setMessages(prev => [...prev, assistantMessage])
      
      // Show warning toast if vector search had issues
      if (data.diagnostics?.vector_search_error) {
        toast.warning(data.diagnostics.vector_search_error, { duration: 8000 })
      }
      
    } catch (error) {
      console.error("Error sending message:", error)
      toast.error(t("agent.errors.chatFailed"))
      
      setMessages(prev => prev.filter(m => m.id !== userMessage.id))
      setInputMessage(userMessage.content)
    } finally {
      setIsLoading(false)
    }
  }
  
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }
  
  function clearConversation() {
    setMessages([])
    toast.success(t("agent.chat.clear"))
  }
  
  async function copyToClipboard(text: string, id?: string) {
    try {
      await navigator.clipboard.writeText(text)
      if (id) {
        setCopiedId(id)
        setTimeout(() => setCopiedId(null), 2000)
      }
      toast.success("Copiado!")
    } catch {
      toast.error("Falha ao copiar")
    }
  }
  
  function handleFeedback(messageId: string, feedback: "positive" | "negative") {
    setMessages(prev => prev.map(m => 
      m.id === messageId ? { ...m, feedback } : m
    ))
    toast.success(t("agent.feedback.thankYou"))
  }
  
  function setExampleQuestion(question: string) {
    setInputMessage(question)
    setShowExamplesPopover(false)
    inputRef.current?.focus()
  }
  
  function getProfileIcon(profileId: string) {
    switch (profileId) {
      case "buyer": return "🛒"
      case "analyst": return "📊"
      case "legal": return "⚖️"
      default: return "👤"
    }
  }
  
  function getExamplesForProfile(profileId: string): string[] {
    return PROFILE_EXAMPLES[profileId] || PROFILE_EXAMPLES.default
  }
  
  function openSourcesModal(sources: Source[]) {
    setSelectedSources(sources)
    setShowSourcesModal(true)
  }
  
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-[var(--color-text)]">
          {t("agent.title")}
        </h1>
        <p className="mt-2 text-base text-gray-600">
          {t("agent.subtitle")}
        </p>
      </div>
      
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Left Panel - Profile Selection & Metrics */}
        <div className="lg:col-span-1 space-y-4">
          {/* Profile Selection */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-[var(--color-text)]">
                {t("agent.profile.title")}
              </h3>
              <button
                onClick={() => setShowProfileModal(true)}
                className="p-1.5 text-gray-500 hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-light)] rounded-lg transition-colors"
                title={t("agent.profile.manage")}
              >
                <Settings className="h-4 w-4" />
              </button>
            </div>
            
            {/* Profile Dropdown */}
            <div className="relative" ref={profileDropdownRef}>
              <button
                onClick={() => setShowProfileDropdown(!showProfileDropdown)}
                disabled={isLoadingProfiles}
                className="w-full flex items-center justify-between px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors text-left"
              >
                {isLoadingProfiles ? (
                  <span className="flex items-center gap-2 text-gray-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("common.loading")}
                  </span>
                ) : selectedProfile ? (
                  <span className="flex items-center gap-2">
                    <span>{getProfileIcon(selectedProfile.id)}</span>
                    <span className="font-medium text-[var(--color-text)]">
                      {selectedProfile.name}
                    </span>
                  </span>
                ) : (
                  <span className="text-gray-500">{t("agent.profile.select")}</span>
                )}
                <ChevronDown className="h-4 w-4 text-gray-400" />
              </button>
              
              {showProfileDropdown && (
                <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
                  {profiles.filter(p => p.is_active).map(profile => (
                    <button
                      key={profile.id}
                      onClick={() => {
                        setSelectedProfile(profile)
                        setShowProfileDropdown(false)
                      }}
                      className={`w-full flex items-start gap-3 px-3 py-3 hover:bg-gray-50 transition-colors text-left ${
                        selectedProfile?.id === profile.id ? "bg-[var(--color-primary-light)]" : ""
                      }`}
                    >
                      <span className="text-lg">{getProfileIcon(profile.id)}</span>
                      <div>
                        <div className="font-medium text-[var(--color-text)]">
                          {profile.name}
                        </div>
                        <div className="text-xs text-gray-500 line-clamp-2">
                          {profile.description}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            
            {/* Selected Profile Description with Help Icon */}
            {selectedProfile && (
              <div className="mt-3 p-3 bg-[var(--color-primary-light)] rounded-lg relative">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs text-gray-600 leading-relaxed flex-1">
                    {selectedProfile.description}
                  </p>
                  
                  {/* Help Icon with Examples Popover */}
                  <div className="relative" ref={examplesRef}>
                    <button
                      onClick={() => setShowExamplesPopover(!showExamplesPopover)}
                      className="p-1.5 text-[var(--color-primary)] hover:bg-white/50 rounded-lg transition-colors flex-shrink-0"
                      title="Exemplos de perguntas"
                    >
                      <HelpCircle className="h-5 w-5" />
                    </button>
                    
                    {/* Examples Popover */}
                    {showExamplesPopover && (
                      <div className="absolute right-0 top-full mt-2 w-80 bg-white border border-gray-200 rounded-xl shadow-xl z-20 overflow-hidden">
                        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
                          <h4 className="font-semibold text-sm text-[var(--color-text)]">
                            Exemplos de perguntas
                          </h4>
                          <p className="text-xs text-gray-500 mt-0.5">
                            Clique para usar ou copie
                          </p>
                        </div>
                        <div className="max-h-72 overflow-y-auto">
                          {getExamplesForProfile(selectedProfile.id).map((question, idx) => (
                            <div
                              key={idx}
                              className="px-4 py-2.5 border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors group"
                            >
                              <div className="flex items-start gap-2">
                                <button
                                  onClick={() => setExampleQuestion(question)}
                                  className="flex-1 text-left text-sm text-gray-700 hover:text-[var(--color-primary)]"
                                >
                                  {question}
                                </button>
                                <button
                                  onClick={() => copyToClipboard(question)}
                                  className="p-1 text-gray-400 hover:text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity"
                                  title="Copiar"
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
          
          {/* Metrics Panel */}
          {messages.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
              <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">
                {t("agent.metrics.title")}
              </h3>
              
              {(() => {
                const lastAssistant = [...messages].reverse().find(m => m.role === "assistant")
                if (!lastAssistant) return null
                
                return (
                  <div className="space-y-3">
                    {/* Tokens */}
                    {lastAssistant.token_usage && (
                      <div>
                        <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
                          <Zap className="h-3.5 w-3.5" />
                          {t("agent.metrics.tokens")}
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <div className="bg-gray-50 rounded-lg px-2 py-1.5 text-center">
                            <div className="text-xs text-gray-500">{t("agent.metrics.promptTokens")}</div>
                            <div className="text-sm font-semibold text-[var(--color-text)]">
                              {lastAssistant.token_usage.prompt_tokens}
                            </div>
                          </div>
                          <div className="bg-gray-50 rounded-lg px-2 py-1.5 text-center">
                            <div className="text-xs text-gray-500">{t("agent.metrics.completionTokens")}</div>
                            <div className="text-sm font-semibold text-[var(--color-text)]">
                              {lastAssistant.token_usage.completion_tokens}
                            </div>
                          </div>
                          <div className="bg-[var(--color-primary-light)] rounded-lg px-2 py-1.5 text-center">
                            <div className="text-xs text-gray-500">{t("agent.metrics.totalTokens")}</div>
                            <div className="text-sm font-semibold text-[var(--color-primary)]">
                              {lastAssistant.token_usage.total_tokens}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                    
                    {/* Sources - Clickable */}
                    <button
                      onClick={() => lastAssistant.sources && openSourcesModal(lastAssistant.sources)}
                      className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-gray-50 transition-colors group"
                      disabled={!lastAssistant.sources || lastAssistant.sources.length === 0}
                    >
                      <div className="flex items-center gap-2 text-xs text-gray-500">
                        <FileText className="h-3.5 w-3.5" />
                        {t("agent.metrics.sources")}
                      </div>
                      <div className="flex items-center gap-1">
                        <span className={`text-sm font-semibold ${
                          lastAssistant.sources && lastAssistant.sources.length > 0 
                            ? "text-[var(--color-primary)] group-hover:underline" 
                            : "text-gray-400"
                        }`}>
                          {lastAssistant.sources?.length || 0}
                        </span>
                        {lastAssistant.sources && lastAssistant.sources.length > 0 && (
                          <ExternalLink className="h-3 w-3 text-[var(--color-primary)] opacity-0 group-hover:opacity-100 transition-opacity" />
                        )}
                      </div>
                    </button>
                    
                    {/* Vector Search Warning */}
                    {lastAssistant.diagnostics?.vector_search_status !== "success" && lastAssistant.diagnostics?.vector_search_error && (
                      <div className="p-2 rounded-lg bg-[var(--color-warning-light)] border border-[var(--color-warning)]/30">
                        <div className="flex items-start gap-2">
                          <AlertCircle className="h-4 w-4 text-[var(--color-warning)] flex-shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-[var(--color-warning)]">
                              {lastAssistant.diagnostics.vector_search_status === "index_not_found" && "Índice não encontrado"}
                              {lastAssistant.diagnostics.vector_search_status === "index_not_ready" && "Índice não pronto"}
                              {lastAssistant.diagnostics.vector_search_status === "query_failed" && "Erro na busca"}
                              {!["index_not_found", "index_not_ready", "query_failed"].includes(lastAssistant.diagnostics.vector_search_status) && "Problema na busca"}
                            </p>
                            <p className="text-xs text-gray-600 mt-0.5 break-words">
                              {lastAssistant.diagnostics.vector_search_error}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                    
                    {/* Trace ID */}
                    {lastAssistant.trace_id && (
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-xs text-gray-500">
                          <Clock className="h-3.5 w-3.5" />
                          {t("agent.metrics.traceId")}
                        </div>
                        <code className="text-xs font-mono text-gray-600 bg-gray-100 px-2 py-0.5 rounded">
                          {lastAssistant.trace_id}
                        </code>
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
          )}
        </div>
        
        {/* Main Chat Area */}
        <div className="lg:col-span-3">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col h-[calc(100vh-220px)]">
            {/* Chat Header */}
            <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bot className="h-5 w-5 text-[var(--color-primary)]" />
                <span className="font-medium text-[var(--color-text)]">
                  {selectedProfile ? selectedProfile.name : t("agent.title")}
                </span>
              </div>
              {messages.length > 0 && (
                <button
                  onClick={clearConversation}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                  {t("agent.chat.clear")}
                </button>
              )}
            </div>
            
            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-500">
                  <Bot className="h-16 w-16 mb-4 text-gray-300" />
                  <p className="text-lg font-medium">{t("agent.chat.noMessages")}</p>
                  <p className="text-sm mt-1">
                    {selectedProfile 
                      ? `${t("agent.profile.title")}: ${selectedProfile.name}`
                      : t("agent.profile.select")
                    }
                  </p>
                  
                  {/* Quick start suggestions */}
                  {selectedProfile && (
                    <div className="mt-6 w-full max-w-md">
                      <p className="text-xs text-gray-400 mb-3 text-center">Sugestões para começar:</p>
                      <div className="space-y-2">
                        {getExamplesForProfile(selectedProfile.id).slice(0, 3).map((question, idx) => (
                          <button
                            key={idx}
                            onClick={() => setExampleQuestion(question)}
                            className="w-full px-4 py-2.5 text-sm text-left text-gray-600 bg-gray-50 hover:bg-[var(--color-primary-light)] hover:text-[var(--color-primary)] rounded-lg transition-colors border border-gray-200"
                          >
                            {question}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                messages.map(message => (
                  <div
                    key={message.id}
                    className={`flex gap-3 ${message.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    {message.role === "assistant" && (
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[var(--color-primary)] flex items-center justify-center">
                        <Bot className="h-5 w-5 text-white" />
                      </div>
                    )}
                    
                    <div className={`max-w-[80%] ${message.role === "user" ? "order-first" : ""}`}>
                      <div
                        className={`rounded-2xl px-4 py-3 ${
                          message.role === "user"
                            ? "bg-[var(--color-primary)] text-white rounded-br-md"
                            : "bg-gray-100 text-gray-800 rounded-bl-md"
                        }`}
                      >
                        <p className="whitespace-pre-wrap text-sm leading-relaxed">
                          {message.content}
                        </p>
                        
                        {/* Source references inline for assistant messages */}
                        {message.role === "assistant" && message.sources && message.sources.length > 0 && (
                          <div className="mt-3 pt-3 border-t border-gray-200/50">
                            <div className="flex flex-wrap gap-1.5">
                              {message.sources.map((source, idx) => (
                                <button
                                  key={idx}
                                  onClick={() => openSourcesModal(message.sources!)}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-white/80 hover:bg-white text-gray-600 rounded-md transition-colors"
                                  title={`${source.file_name} - Score: ${(source.score * 100).toFixed(1)}%`}
                                >
                                  <FileText className="h-3 w-3" />
                                  <span className="font-medium">[{idx + 1}]</span>
                                  <span className="truncate max-w-[100px]">{source.file_name}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                      
                      {/* Message Actions */}
                      {message.role === "assistant" && (
                        <div className="flex items-center gap-2 mt-2">
                          <button
                            onClick={() => copyToClipboard(message.content, message.id)}
                            className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                            title={t("agent.chat.copy")}
                          >
                            {copiedId === message.id ? (
                              <Check className="h-4 w-4 text-green-500" />
                            ) : (
                              <Copy className="h-4 w-4" />
                            )}
                          </button>
                          
                          <div className="flex items-center gap-1 ml-2">
                            <button
                              onClick={() => handleFeedback(message.id, "positive")}
                              className={`p-1.5 rounded-lg transition-colors ${
                                message.feedback === "positive"
                                  ? "text-green-500 bg-green-50"
                                  : "text-gray-400 hover:text-green-500 hover:bg-green-50"
                              }`}
                            >
                              <ThumbsUp className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleFeedback(message.id, "negative")}
                              className={`p-1.5 rounded-lg transition-colors ${
                                message.feedback === "negative"
                                  ? "text-red-500 bg-red-50"
                                  : "text-gray-400 hover:text-red-500 hover:bg-red-50"
                              }`}
                            >
                              <ThumbsDown className="h-4 w-4" />
                            </button>
                          </div>
                          
                          {/* Sources count badge */}
                          {message.sources && message.sources.length > 0 && (
                            <button
                              onClick={() => openSourcesModal(message.sources!)}
                              className="flex items-center gap-1 ml-2 px-2 py-1 text-xs text-[var(--color-accent)] bg-[var(--color-accent-light)] hover:bg-[var(--color-accent-lighter)] rounded-lg transition-colors"
                            >
                              <FileText className="h-3.5 w-3.5" />
                              {message.sources.length} fonte{message.sources.length > 1 ? "s" : ""}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    
                    {message.role === "user" && (
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
                        <User className="h-5 w-5 text-gray-600" />
                      </div>
                    )}
                  </div>
                ))
              )}
              
              {/* Loading indicator */}
              {isLoading && (
                <div className="flex gap-3 justify-start">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[var(--color-primary)] flex items-center justify-center">
                    <Bot className="h-5 w-5 text-white" />
                  </div>
                  <div className="bg-gray-100 rounded-2xl rounded-bl-md px-4 py-3">
                    <div className="flex items-center gap-2 text-gray-500">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span className="text-sm">{t("agent.chat.thinking")}</span>
                    </div>
                  </div>
                </div>
              )}
              
              <div ref={messagesEndRef} />
            </div>
            
            {/* Input Area */}
            <div className="border-t border-gray-200 p-4 bg-gray-50">
              <div className="flex gap-3">
                <textarea
                  ref={inputRef}
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={t("agent.chat.placeholder")}
                  disabled={isLoading || !selectedProfile}
                  rows={1}
                  className="flex-1 resize-none rounded-xl border border-gray-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed"
                  style={{ minHeight: "48px", maxHeight: "120px" }}
                />
                <button
                  onClick={sendMessage}
                  disabled={isLoading || !inputMessage.trim() || !selectedProfile}
                  className="flex-shrink-0 px-4 py-2 bg-[var(--color-primary)] text-white rounded-xl hover:bg-[var(--color-primary)]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {isLoading ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Send className="h-5 w-5" />
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      {/* Profile Management Modal */}
      {showProfileModal && (
        <ProfileModal
          profiles={profiles}
          onClose={() => {
            setShowProfileModal(false)
            setEditingProfile(null)
          }}
          onSave={() => {
            loadProfiles()
            setEditingProfile(null)
          }}
          editingProfile={editingProfile}
          setEditingProfile={setEditingProfile}
          t={t}
        />
      )}
      
      {/* Sources Modal */}
      {showSourcesModal && (
        <SourcesModal
          sources={selectedSources}
          onClose={() => setShowSourcesModal(false)}
          t={t}
        />
      )}
    </div>
  )
}

// Sources Modal Component
function SourcesModal({
  sources,
  onClose,
  t
}: {
  sources: Source[]
  onClose: () => void
  t: (key: string) => string
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between bg-[var(--color-accent-light)]">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-[var(--color-accent)]" />
            <h2 className="text-lg font-semibold text-[var(--color-text)]">
              {t("agent.chat.sources")} ({sources.length})
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-white/50 rounded-lg transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        
        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {sources.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              {t("agent.chat.noSources")}
            </div>
          ) : (
            sources.map((source, idx) => (
              <div
                key={idx}
                className="border border-gray-200 rounded-xl overflow-hidden"
              >
                {/* Source Header */}
                <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="flex items-center justify-center w-6 h-6 rounded-full bg-[var(--color-primary)] text-white text-xs font-bold">
                      {idx + 1}
                    </span>
                    <div>
                      <div className="font-medium text-[var(--color-text)]">
                        {source.file_name}
                      </div>
                      <div className="text-xs text-gray-500">
                        Segmento {source.chunk_index} • ID: {source.chunk_id}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-1 rounded-lg text-xs font-medium ${
                      source.score >= 0.7 
                        ? "bg-green-100 text-green-700"
                        : source.score >= 0.5
                        ? "bg-yellow-100 text-yellow-700"
                        : "bg-gray-100 text-gray-700"
                    }`}>
                      {(source.score * 100).toFixed(1)}% relevância
                    </span>
                  </div>
                </div>
                
                {/* Source Content */}
                {source.content && (
                  <div className="p-4 bg-white">
                    <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                      {source.content}
                    </p>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
        
        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button
            onClick={onClose}
            className="w-full px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  )
}

// Profile Management Modal Component
function ProfileModal({
  profiles,
  onClose,
  onSave,
  editingProfile,
  setEditingProfile,
  t
}: {
  profiles: Profile[]
  onClose: () => void
  onSave: () => void
  editingProfile: Profile | null
  setEditingProfile: (p: Profile | null) => void
  t: (key: string) => string
}) {
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    system_prompt: ""
  })
  const [isSaving, setIsSaving] = useState(false)
  const [showForm, setShowForm] = useState(false)
  
  useEffect(() => {
    if (editingProfile) {
      setFormData({
        name: editingProfile.name,
        description: editingProfile.description,
        system_prompt: editingProfile.system_prompt
      })
      setShowForm(true)
    }
  }, [editingProfile])
  
  async function handleSave() {
    if (!formData.name || !formData.system_prompt) {
      toast.warning(t("import.validation.fillAllFields"))
      return
    }
    
    setIsSaving(true)
    try {
      const url = editingProfile 
        ? `/api/profiles/${editingProfile.id}`
        : "/api/profiles"
      
      const method = editingProfile ? "PUT" : "POST"
      
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData)
      })
      
      if (!response.ok) throw new Error("Failed to save profile")
      
      toast.success(
        editingProfile 
          ? t("agent.toast.profileUpdated") 
          : t("agent.toast.profileCreated")
      )
      
      setFormData({ name: "", description: "", system_prompt: "" })
      setShowForm(false)
      setEditingProfile(null)
      onSave()
      
    } catch (error) {
      console.error("Error saving profile:", error)
      toast.error(t("common.error"))
    } finally {
      setIsSaving(false)
    }
  }
  
  async function handleDelete(profileId: string) {
    if (!confirm(t("agent.profile.confirmDelete"))) return
    
    try {
      const response = await fetch(`/api/profiles/${profileId}`, {
        method: "DELETE"
      })
      
      if (!response.ok) throw new Error("Failed to delete profile")
      
      toast.success(t("agent.toast.profileDeleted"))
      onSave()
      
    } catch (error) {
      console.error("Error deleting profile:", error)
      toast.error(t("common.error"))
    }
  }
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-[var(--color-primary)]" />
            <h2 className="text-lg font-semibold text-[var(--color-text)]">
              {t("agent.profile.manage")}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        
        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {showForm ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-medium text-[var(--color-text)]">
                  {editingProfile ? t("agent.profile.edit") : t("agent.profile.create")}
                </h3>
                <button
                  onClick={() => {
                    setShowForm(false)
                    setEditingProfile(null)
                    setFormData({ name: "", description: "", system_prompt: "" })
                  }}
                  className="text-sm text-gray-500 hover:text-gray-700"
                >
                  {t("common.cancel")}
                </button>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t("agent.profile.name")}
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
                  placeholder="Ex: Analista de Riscos"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t("agent.profile.description")}
                </label>
                <input
                  type="text"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
                  placeholder="Breve descrição do perfil"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t("agent.profile.systemPrompt")}
                </label>
                <textarea
                  value={formData.system_prompt}
                  onChange={(e) => setFormData({ ...formData, system_prompt: e.target.value })}
                  rows={8}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent font-mono text-sm"
                  placeholder="Instruções para o agente..."
                />
              </div>
              
              <div className="flex justify-end gap-3 pt-4">
                <button
                  onClick={() => {
                    setShowForm(false)
                    setEditingProfile(null)
                  }}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  {t("common.cancel")}
                </button>
                <button
                  onClick={handleSave}
                  disabled={isSaving}
                  className="px-4 py-2 text-sm font-medium text-white bg-[var(--color-primary)] rounded-lg hover:bg-[var(--color-primary)]/90 transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("common.save")}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <button
                onClick={() => setShowForm(true)}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-500 hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-colors"
              >
                <Plus className="h-5 w-5" />
                {t("agent.profile.create")}
              </button>
              
              {profiles.map(profile => (
                <div
                  key={profile.id}
                  className="flex items-start gap-4 p-4 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-[var(--color-text)]">
                        {profile.name}
                      </span>
                      {!profile.is_active && (
                        <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-500 rounded">
                          Inativo
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-500 mt-1">
                      {profile.description}
                    </p>
                  </div>
                  
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setEditingProfile(profile)}
                      className="p-2 text-gray-400 hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-light)] rounded-lg transition-colors"
                      title={t("agent.profile.edit")}
                    >
                      <Edit2 className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(profile.id)}
                      className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                      title={t("agent.profile.delete")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
