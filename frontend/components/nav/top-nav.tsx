"use client"

import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState, useRef, useEffect, useCallback } from "react"
import { User, Settings, ChevronDown, Sparkles, Send, Loader2, X } from "lucide-react"
import databricksLogo from "@/app/assets/databricks.png"
import { useTranslation, Locale } from "@/lib/i18n"
import { useTheme } from "@/lib/theme"

// Flag components for language selector
function USFlag({ className = "w-5 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 640 480" xmlns="http://www.w3.org/2000/svg">
      <g fillRule="evenodd">
        <g strokeWidth="1pt">
          <path fill="#bd3d44" d="M0 0h972.8v39.4H0zm0 78.8h972.8v39.4H0zm0 78.7h972.8V197H0zm0 78.8h972.8v39.4H0zm0 78.8h972.8v39.4H0zm0 78.7h972.8v39.4H0zm0 78.8h972.8V512H0z" transform="scale(.9375 .9375)"/>
          <path fill="#fff" d="M0 39.4h972.8v39.4H0zm0 78.8h972.8v39.3H0zm0 78.7h972.8v39.4H0zm0 78.8h972.8v39.4H0zm0 78.8h972.8v39.4H0zm0 78.7h972.8v39.4H0z" transform="scale(.9375 .9375)"/>
        </g>
        <path fill="#192f5d" d="M0 0h389.1v275.7H0z" transform="scale(.9375 .9375)"/>
      </g>
    </svg>
  )
}

function BrazilFlag({ className = "w-5 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 640 480" xmlns="http://www.w3.org/2000/svg">
      <g strokeWidth="1pt">
        <path fill="#229e45" fillRule="evenodd" d="M0 0h640v480H0z"/>
        <path fill="#f8e509" fillRule="evenodd" d="m323.4 36.2 301.5 203.6-306.8 203.6-301.4-203.6 306.7-203.6z"/>
        <path fill="#2b49a3" fillRule="evenodd" d="M452.8 240c0 70.3-57.1 127.3-127.6 127.3A127.4 127.4 0 1 1 452.8 240z"/>
        <path fill="#ffffef" fillRule="evenodd" d="M283.3 316.3l-4-2.3-4 2 .9-4.5-3.2-3.2 4.5-.5 1.8-4.1 2 4.1 4.4.6-3 3.1.6 4.6zm86 26.3l-4-2.3-4 2 .8-4.5-3.1-3.2 4.4-.5 1.9-4.1 2 4.1 4.4.6-3 3.1.5 4.6zm-36.2 19l-4-2.3-4 2 .8-4.5-3.1-3.2 4.4-.5 1.9-4.1 2 4.1 4.4.6-3 3.1.5 4.6z"/>
      </g>
    </svg>
  )
}

export function TopNav() {
  const pathname = usePathname()
  const { locale, setLocale, t } = useTranslation()
  const { theme } = useTheme()
  const [isProfileOpen, setIsProfileOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const profileRef = useRef<HTMLDivElement>(null)
  
  const navItems = [
    { href: "/import", labelKey: "app.nav.import" },
    { href: "/prepare", labelKey: "app.nav.prepare" },
  ]

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(event.target as Node)) {
        setIsProfileOpen(false)
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const handleLanguageChange = (code: Locale) => {
    setLocale(code)
  }
  
  return (
    <>
      <nav className="border-b bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex">
              <div className="flex-shrink-0 flex items-center gap-3">
                {theme.logo_url ? (
                  <img
                    src={theme.logo_url}
                    alt="Logo"
                    className="h-8 w-auto"
                  />
                ) : (
                  <Image
                    src={databricksLogo}
                    alt="Databricks"
                    width={32}
                    height={32}
                    className="h-8 w-auto"
                    priority
                  />
                )}
                <span className="text-xl font-bold" style={{ color: theme.text_color }}>
                  {theme.app_name || t("app.name")}
                </span>
              </div>
              <div className="hidden sm:ml-8 sm:flex sm:space-x-6">
                {navItems.map((item) => {
                  const isActive = pathname === item.href || 
                                   pathname === `${item.href}/` || 
                                   pathname?.startsWith(`${item.href}/`)
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="inline-flex items-center px-2 py-2 text-sm transition-all duration-200"
                      style={{
                        color: isActive ? theme.primary_color : "#6B7280",
                        fontWeight: isActive ? 700 : 500
                      }}
                    >
                      {t(item.labelKey)}
                    </Link>
                  )
                })}
              </div>
            </div>

            {/* User Profile Menu */}
            <div className="flex items-center">
              <div className="relative" ref={profileRef}>
                <button
                  onClick={() => setIsProfileOpen(!isProfileOpen)}
                  className="flex items-center justify-center w-10 h-10 rounded-full bg-gray-100 hover:bg-gray-200 transition-colors border-2 border-gray-200"
                  aria-label="User menu"
                >
                  <User className="h-5 w-5 text-gray-600" />
                </button>

                {isProfileOpen && (
                  <div className="absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-lg border border-gray-200 py-2 z-50">
                    {/* Language Selection */}
                    <div className="px-4 py-2 border-b border-gray-100">
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                        {t("language.select")}
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleLanguageChange("en")}
                          className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors flex-1 ${
                            locale === "en"
                              ? "bg-[var(--color-primary-light)] border-2"
                              : "bg-gray-50 hover:bg-gray-100 border-2 border-transparent"
                          }`}
                          style={{
                            borderColor: locale === "en" ? theme.primary_color : "transparent"
                          }}
                          title="English"
                        >
                          <USFlag className="w-6 h-4" />
                          <span className="text-xs font-medium">EN</span>
                        </button>
                        <button
                          onClick={() => handleLanguageChange("pt-BR")}
                          className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors flex-1 ${
                            locale === "pt-BR"
                              ? "bg-[var(--color-primary-light)] border-2"
                              : "bg-gray-50 hover:bg-gray-100 border-2 border-transparent"
                          }`}
                          style={{
                            borderColor: locale === "pt-BR" ? theme.primary_color : "transparent"
                          }}
                          title="Português"
                        >
                          <BrazilFlag className="w-6 h-4" />
                          <span className="text-xs font-medium">PT</span>
                        </button>
                      </div>
                    </div>
                    
                    {/* Settings Link */}
                    <div className="px-2 pt-2">
                      <button
                        onClick={() => {
                          setIsProfileOpen(false)
                          setIsSettingsOpen(true)
                        }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
                      >
                        <Settings className="h-4 w-4 text-gray-500" />
                        <span>{locale === "pt-BR" ? "Configurações" : "Settings"}</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </nav>

      {/* Settings Modal */}
      {isSettingsOpen && (
        <SettingsModal onClose={() => setIsSettingsOpen(false)} />
      )}
    </>
  )
}

// Settings Modal Component
function SettingsModal({ onClose }: { onClose: () => void }) {
  const { theme, updateTheme, resetTheme, isLoading } = useTheme()
  const { locale, t } = useTranslation()
  const [localTheme, setLocalTheme] = useState(theme)
  const [isSaving, setIsSaving] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)
  
  // AI Assistant state
  const [showAIAssistant, setShowAIAssistant] = useState(false)
  const [companyInput, setCompanyInput] = useState("")
  const [isAILoading, setIsAILoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const aiInputRef = useRef<HTMLInputElement>(null)

  const colorFields = [
    { 
      key: "primary_color", 
      label: locale === "pt-BR" ? "Cor Primária" : "Primary Color",
      description: locale === "pt-BR" ? "Botões, links e destaques" : "Buttons, links and highlights"
    },
    { 
      key: "text_color", 
      label: locale === "pt-BR" ? "Cor do Texto" : "Text Color",
      description: locale === "pt-BR" ? "Títulos e textos importantes" : "Headings and important text"
    },
    { 
      key: "success_color", 
      label: locale === "pt-BR" ? "Cor de Sucesso" : "Success Color",
      description: locale === "pt-BR" ? "Estados de sucesso" : "Success states"
    },
    { 
      key: "accent_color", 
      label: locale === "pt-BR" ? "Cor de Destaque" : "Accent Color",
      description: locale === "pt-BR" ? "Informações e acentos" : "Information and accents"
    }
  ]

  const handleColorChange = (key: string, value: string) => {
    setLocalTheme(prev => ({ ...prev, [key]: value }))
    setHasChanges(true)
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      await updateTheme(localTheme)
      setHasChanges(false)
      onClose()
    } catch (error) {
      console.error("Error saving theme:", error)
    } finally {
      setIsSaving(false)
    }
  }

  const handleReset = async () => {
    setIsSaving(true)
    try {
      await resetTheme()
      setLocalTheme({
        primary_color: "#FF3621",
        text_color: "#1B1B1D",
        success_color: "#00A972",
        accent_color: "#1857B6",
        logo_url: "",
        app_name: "Contracts App"
      })
      setHasChanges(false)
    } catch (error) {
      console.error("Error resetting theme:", error)
    } finally {
      setIsSaving(false)
    }
  }

  // AI Assistant - Generate config from company name
  const handleAIGenerate = async () => {
    if (!companyInput.trim()) return
    
    setIsAILoading(true)
    setAiError(null)
    
    try {
      const response = await fetch("/api/ai-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_name: companyInput.trim() })
      })
      
      const data = await response.json()
      
      if (data.success && data.config) {
        // Apply AI-generated config to local theme
        setLocalTheme(prev => ({
          ...prev,
          primary_color: data.config.primary_color || prev.primary_color,
          text_color: data.config.text_color || prev.text_color,
          success_color: data.config.success_color || prev.success_color,
          accent_color: data.config.accent_color || prev.accent_color,
          app_name: data.config.app_name || prev.app_name
        }))
        setHasChanges(true)
        setShowAIAssistant(false)
        setCompanyInput("")
      } else {
        setAiError(data.error || (locale === "pt-BR" ? "Erro ao gerar configuração" : "Error generating config"))
      }
    } catch (error) {
      console.error("AI config error:", error)
      setAiError(locale === "pt-BR" ? "Erro de conexão" : "Connection error")
    } finally {
      setIsAILoading(false)
    }
  }

  // Focus input when AI assistant opens
  useEffect(() => {
    if (showAIAssistant && aiInputRef.current) {
      aiInputRef.current.focus()
    }
  }, [showAIAssistant])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-xl w-full max-h-[90vh] flex flex-col relative">
        
        {/* AI Assistant Button - Top Right */}
        <button
          onClick={() => setShowAIAssistant(!showAIAssistant)}
          className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 hover:from-purple-600 hover:to-indigo-700 text-white shadow-lg transition-all hover:scale-105 z-10"
          title={locale === "pt-BR" ? "Assistente AI" : "AI Assistant"}
        >
          <Sparkles className="h-5 w-5" />
        </button>

        {/* AI Assistant Overlay */}
        {showAIAssistant && (
          <div className="absolute top-16 right-4 w-72 bg-white rounded-xl shadow-2xl border border-gray-200 z-20 overflow-hidden">
            <div className="bg-gradient-to-r from-purple-500 to-indigo-600 px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-white" />
                  <span className="text-sm font-semibold text-white">
                    {locale === "pt-BR" ? "Assistente AI" : "AI Assistant"}
                  </span>
                </div>
                <button
                  onClick={() => setShowAIAssistant(false)}
                  className="text-white/80 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            
            <div className="p-4">
              <p className="text-xs text-gray-600 mb-3">
                {locale === "pt-BR" 
                  ? "Digite o nome da empresa ou URL do site para gerar automaticamente as cores da identidade visual."
                  : "Enter company name or website URL to auto-generate brand colors."}
              </p>
              
              <div className="flex gap-2">
                <input
                  ref={aiInputRef}
                  type="text"
                  value={companyInput}
                  onChange={(e) => setCompanyInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAIGenerate()}
                  placeholder={locale === "pt-BR" ? "Ex: Databricks, Apple..." : "Ex: Databricks, Apple..."}
                  className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
                  disabled={isAILoading}
                />
                <button
                  onClick={handleAIGenerate}
                  disabled={isAILoading || !companyInput.trim()}
                  className="px-3 py-2 bg-gradient-to-r from-purple-500 to-indigo-600 text-white rounded-lg hover:from-purple-600 hover:to-indigo-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isAILoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </button>
              </div>
              
              {isAILoading && (
                <p className="text-xs text-purple-600 mt-2 flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {locale === "pt-BR" ? "Analisando identidade visual..." : "Analyzing brand identity..."}
                </p>
              )}
              
              {aiError && (
                <p className="text-xs text-[var(--color-primary)] mt-2">{aiError}</p>
              )}
            </div>
          </div>
        )}

        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 pr-16">
          <h2 className="text-xl font-bold text-gray-900">
            {locale === "pt-BR" ? "Configurações do Aplicativo" : "Application Settings"}
          </h2>
          <p className="text-sm text-gray-600 mt-1">
            {locale === "pt-BR" 
              ? "Personalize as cores e aparência do aplicativo" 
              : "Customize the app colors and appearance"}
          </p>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* App Name */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {locale === "pt-BR" ? "Nome do Aplicativo" : "Application Name"}
            </label>
            <input
              type="text"
              value={localTheme.app_name}
              onChange={(e) => {
                setLocalTheme(prev => ({ ...prev, app_name: e.target.value }))
                setHasChanges(true)
              }}
              placeholder="Contracts App"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)]"
            />
          </div>

          {/* Logo URL */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {locale === "pt-BR" ? "URL do Logo (opcional)" : "Logo URL (optional)"}
            </label>
            <input
              type="url"
              value={localTheme.logo_url}
              onChange={(e) => {
                setLocalTheme(prev => ({ ...prev, logo_url: e.target.value }))
                setHasChanges(true)
              }}
              placeholder="https://example.com/logo.png"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)]"
            />
            <p className="mt-1 text-xs text-gray-500">
              {locale === "pt-BR" 
                ? "Deixe vazio para usar o logo padrão do Databricks" 
                : "Leave empty to use default Databricks logo"}
            </p>
          </div>

          {/* Color Palette */}
          <div className="mb-4">
            <h3 className="text-sm font-medium text-gray-700 mb-3">
              {locale === "pt-BR" ? "Paleta de Cores" : "Color Palette"}
            </h3>
            <div className="grid grid-cols-2 gap-4">
              {colorFields.map((field) => (
                <div key={field.key} className="bg-gray-50 rounded-lg p-3">
                  <div className="flex items-center gap-3 mb-2">
                    <input
                      type="color"
                      value={localTheme[field.key as keyof typeof localTheme] as string}
                      onChange={(e) => handleColorChange(field.key, e.target.value)}
                      className="w-10 h-10 rounded-lg border border-gray-300 cursor-pointer"
                      style={{ padding: 0 }}
                    />
                    <div>
                      <p className="text-sm font-medium text-gray-900">{field.label}</p>
                      <p className="text-xs text-gray-500">{field.description}</p>
                    </div>
                  </div>
                  <input
                    type="text"
                    value={localTheme[field.key as keyof typeof localTheme] as string}
                    onChange={(e) => handleColorChange(field.key, e.target.value)}
                    className="w-full px-2 py-1 text-xs font-mono border border-gray-200 rounded bg-white"
                    placeholder="#FFFFFF"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Preview */}
          <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
              {locale === "pt-BR" ? "Prévia" : "Preview"}
            </p>
            <div className="flex items-center gap-3 flex-wrap">
              <button
                className="px-4 py-2 text-sm font-medium text-white rounded-lg"
                style={{ backgroundColor: localTheme.primary_color }}
              >
                {locale === "pt-BR" ? "Botão Primário" : "Primary Button"}
              </button>
              <span 
                className="text-sm font-semibold"
                style={{ color: localTheme.text_color }}
              >
                {locale === "pt-BR" ? "Texto Principal" : "Main Text"}
              </span>
              <span 
                className="text-sm font-medium"
                style={{ color: localTheme.success_color }}
              >
                {locale === "pt-BR" ? "Sucesso" : "Success"}
              </span>
              <span 
                className="text-sm font-medium"
                style={{ color: localTheme.accent_color }}
              >
                {locale === "pt-BR" ? "Destaque" : "Accent"}
              </span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
          <button
            onClick={handleReset}
            disabled={isSaving}
            className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors disabled:opacity-50"
          >
            {locale === "pt-BR" ? "Restaurar Padrão" : "Reset to Default"}
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              disabled={isSaving}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              {locale === "pt-BR" ? "Cancelar" : "Cancel"}
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving || !hasChanges}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
              style={{ backgroundColor: theme.primary_color }}
            >
              {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              {isSaving 
                ? (locale === "pt-BR" ? "Salvando..." : "Saving...") 
                : (locale === "pt-BR" ? "Salvar" : "Save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
