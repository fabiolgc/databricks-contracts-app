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
    { href: "/agent", labelKey: "app.nav.agent" },
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
  
  // Tab state
  const [activeTab, setActiveTab] = useState<"general" | "appearance">("general")
  const [appearanceSubTab, setAppearanceSubTab] = useState<"identity" | "colors">("identity")
  
  // General config state
  const [generalConfig, setGeneralConfig] = useState({
    catalog: "",
    schema: "",
    tableName: "contracts",
    embeddingModel: "databricks-gte-large-en",
    indexSyncType: "TRIGGERED" as "TRIGGERED" | "CONTINUOUS",
    vsEndpoint: ""
  })
  
  // AI Assistant state
  const [showAIAssistant, setShowAIAssistant] = useState(false)
  const [companyInput, setCompanyInput] = useState("")
  const [isAILoading, setIsAILoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const aiInputRef = useRef<HTMLInputElement>(null)
  
  // Logo preview state
  const [logoError, setLogoError] = useState(false)
  
  // Load general config on mount
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const response = await fetch("/api/config")
        if (response.ok) {
          const config = await response.json()
          setGeneralConfig(prev => ({
            ...prev,
            catalog: config.catalog || "",
            schema: config.schema || "",
            vsEndpoint: config.vectorSearchEndpoint || ""
          }))
        }
        
        const appConfigResponse = await fetch("/api/app-config")
        if (appConfigResponse.ok) {
          const appConfig = await appConfigResponse.json()
          if (appConfig.success && appConfig.config) {
            setGeneralConfig(prev => ({
              ...prev,
              tableName: appConfig.config.table_name || "contracts",
              embeddingModel: appConfig.config.embedding_model || "databricks-gte-large-en",
              indexSyncType: appConfig.config.index_sync_type || "TRIGGERED",
              vsEndpoint: appConfig.config.vs_endpoint || prev.vsEndpoint
            }))
          }
        }
      } catch (error) {
        console.error("Error loading config:", error)
      }
    }
    loadConfig()
  }, [])

  // Main colors
  const mainColorFields = [
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
    },
    { 
      key: "warning_color", 
      label: locale === "pt-BR" ? "Cor de Alerta" : "Warning Color",
      description: locale === "pt-BR" ? "Alertas e avisos" : "Warnings and alerts"
    }
  ]

  // Derived colors (backgrounds)
  const derivedColorFields = [
    { 
      key: "primary_light", 
      label: locale === "pt-BR" ? "Primária Clara" : "Primary Light",
      description: locale === "pt-BR" ? "Fundos de seleção" : "Selection backgrounds",
      baseKey: "primary_color"
    },
    { 
      key: "primary_lighter", 
      label: locale === "pt-BR" ? "Primária Mais Clara" : "Primary Lighter",
      description: locale === "pt-BR" ? "Bordas e hover" : "Borders and hover",
      baseKey: "primary_color"
    },
    { 
      key: "success_light", 
      label: locale === "pt-BR" ? "Sucesso Clara" : "Success Light",
      description: locale === "pt-BR" ? "Fundos de sucesso" : "Success backgrounds",
      baseKey: "success_color"
    },
    { 
      key: "accent_light", 
      label: locale === "pt-BR" ? "Destaque Clara" : "Accent Light",
      description: locale === "pt-BR" ? "Fundos informativos" : "Info backgrounds",
      baseKey: "accent_color"
    },
    { 
      key: "accent_lighter", 
      label: locale === "pt-BR" ? "Destaque Mais Clara" : "Accent Lighter",
      description: locale === "pt-BR" ? "Bordas informativas" : "Info borders",
      baseKey: "accent_color"
    },
    { 
      key: "warning_light", 
      label: locale === "pt-BR" ? "Alerta Clara" : "Warning Light",
      description: locale === "pt-BR" ? "Fundos de alerta" : "Alert backgrounds",
      baseKey: "warning_color"
    }
  ]

  // Helper to generate light color
  const generateLightColor = (hex: string, factor: number): string => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
    if (!result) return hex
    const [r, g, b] = [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)]
    const newR = Math.round(r + (255 - r) * factor)
    const newG = Math.round(g + (255 - g) * factor)
    const newB = Math.round(b + (255 - b) * factor)
    return '#' + [newR, newG, newB].map(x => x.toString(16).padStart(2, '0')).join('')
  }

  const handleColorChange = (key: string, value: string) => {
    setLocalTheme(prev => {
      const updated = { ...prev, [key]: value }
      
      // Auto-regenerate derived colors when main color changes
      if (key === "primary_color") {
        updated.primary_light = generateLightColor(value, 0.92)
        updated.primary_lighter = generateLightColor(value, 0.85)
      } else if (key === "success_color") {
        updated.success_light = generateLightColor(value, 0.92)
        updated.success_lighter = generateLightColor(value, 0.85)
      } else if (key === "accent_color") {
        updated.accent_light = generateLightColor(value, 0.92)
        updated.accent_lighter = generateLightColor(value, 0.85)
      } else if (key === "warning_color") {
        updated.warning_light = generateLightColor(value, 0.92)
      }
      
      return updated
    })
    setHasChanges(true)
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      // Save theme (appearance)
      await updateTheme(localTheme)
      
      // Save general config
      await fetch("/api/app-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          table_name: generalConfig.tableName,
          embedding_model: generalConfig.embeddingModel,
          index_sync_type: generalConfig.indexSyncType,
          vs_endpoint: generalConfig.vsEndpoint
        })
      })
      
      setHasChanges(false)
      onClose()
      
      // Reload page to apply changes
      window.location.reload()
    } catch (error) {
      console.error("Error saving settings:", error)
    } finally {
      setIsSaving(false)
    }
  }
  
  const handleGeneralConfigChange = (key: string, value: string) => {
    setGeneralConfig(prev => ({ ...prev, [key]: value }))
    setHasChanges(true)
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
        warning_color: "#F59E0B",
        logo_url: "",
        app_name: "Contracts App",
        primary_light: "#FFEBE8",
        primary_lighter: "#FFD5CF",
        success_light: "#E6F7F1",
        success_lighter: "#CCF0E3",
        accent_light: "#E8EEF7",
        accent_lighter: "#D1DEEF",
        warning_light: "#FEF3C7"
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
        // Apply AI-generated config to local theme (including derived colors and logo)
        setLocalTheme(prev => ({
          ...prev,
          primary_color: data.config.primary_color || prev.primary_color,
          text_color: data.config.text_color || prev.text_color,
          success_color: data.config.success_color || prev.success_color,
          accent_color: data.config.accent_color || prev.accent_color,
          warning_color: data.config.warning_color || prev.warning_color,
          app_name: data.config.app_name || prev.app_name,
          logo_url: data.config.logo_url || prev.logo_url,
          // Derived colors from AI or auto-generated
          primary_light: data.config.primary_light || generateLightColor(data.config.primary_color || prev.primary_color, 0.92),
          primary_lighter: data.config.primary_lighter || generateLightColor(data.config.primary_color || prev.primary_color, 0.85),
          success_light: data.config.success_light || generateLightColor(data.config.success_color || prev.success_color, 0.92),
          success_lighter: data.config.success_lighter || generateLightColor(data.config.success_color || prev.success_color, 0.85),
          accent_light: data.config.accent_light || generateLightColor(data.config.accent_color || prev.accent_color, 0.92),
          accent_lighter: data.config.accent_lighter || generateLightColor(data.config.accent_color || prev.accent_color, 0.85),
          warning_light: data.config.warning_light || generateLightColor(data.config.warning_color || prev.warning_color || "#F59E0B", 0.92)
        }))
        setLogoError(false) // Reset logo error for new URL
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

        {/* AI Assistant Overlay (controlled from Appearance tab) */}
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
            {locale === "pt-BR" ? "Configurações" : "Settings"}
          </h2>
        </div>
        
        {/* Tabs */}
        <div className="px-6 border-b border-gray-200">
          <div className="flex gap-1">
            <button
              onClick={() => setActiveTab("general")}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "general" 
                  ? "border-[var(--color-primary)] text-[var(--color-primary)]" 
                  : "border-transparent text-gray-600 hover:text-gray-900"
              }`}
            >
              {locale === "pt-BR" ? "Configurações Gerais" : "General Settings"}
            </button>
            <button
              onClick={() => setActiveTab("appearance")}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "appearance" 
                  ? "border-[var(--color-primary)] text-[var(--color-primary)]" 
                  : "border-transparent text-gray-600 hover:text-gray-900"
              }`}
            >
              {locale === "pt-BR" ? "Aparência" : "Appearance"}
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          
          {/* General Settings Tab */}
          {activeTab === "general" && (
            <div className="space-y-6">
              {/* Unity Catalog Configuration */}
              <div>
                <h3 className="text-sm font-semibold text-gray-900 mb-3">
                  {locale === "pt-BR" ? "Unity Catalog" : "Unity Catalog"}
                </h3>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {locale === "pt-BR" ? "Catálogo" : "Catalog"}
                    </label>
                    <input
                      type="text"
                      value={generalConfig.catalog}
                      onChange={(e) => handleGeneralConfigChange("catalog", e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)] bg-gray-50"
                      disabled
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      {locale === "pt-BR" ? "Definido no app.yaml" : "Defined in app.yaml"}
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {locale === "pt-BR" ? "Schema" : "Schema"}
                    </label>
                    <input
                      type="text"
                      value={generalConfig.schema}
                      onChange={(e) => handleGeneralConfigChange("schema", e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)] bg-gray-50"
                      disabled
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      {locale === "pt-BR" ? "Definido no app.yaml" : "Defined in app.yaml"}
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {locale === "pt-BR" ? "Nome da Tabela" : "Table Name"}
                    </label>
                    <input
                      type="text"
                      value={generalConfig.tableName}
                      onChange={(e) => handleGeneralConfigChange("tableName", e.target.value)}
                      placeholder="contracts"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)]"
                    />
                  </div>
                </div>
                
                {/* Tables Preview */}
                <div className="mt-4 p-3 bg-[var(--color-accent-light)] rounded-lg">
                  <p className="text-xs font-medium text-[var(--color-accent)] mb-2">
                    {locale === "pt-BR" ? "Tabelas que serão criadas:" : "Tables that will be created:"}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <code className="text-xs bg-white px-2 py-1 rounded border border-[var(--color-accent-lighter)]">
                      {generalConfig.catalog}.{generalConfig.schema}.{generalConfig.tableName}_parsed
                    </code>
                    <code className="text-xs bg-white px-2 py-1 rounded border border-[var(--color-accent-lighter)]">
                      {generalConfig.catalog}.{generalConfig.schema}.{generalConfig.tableName}_chunks
                    </code>
                  </div>
                </div>
              </div>
              
              {/* Vector Search Configuration */}
              <div>
                <h3 className="text-sm font-semibold text-gray-900 mb-3">
                  {locale === "pt-BR" ? "Vector Search" : "Vector Search"}
                </h3>
                
                {/* Endpoint */}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {locale === "pt-BR" ? "Endpoint" : "Endpoint"}
                  </label>
                  <input
                    type="text"
                    value={generalConfig.vsEndpoint}
                    onChange={(e) => handleGeneralConfigChange("vsEndpoint", e.target.value)}
                    placeholder="one-env-shared-endpoint-12"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)] bg-gray-50"
                    disabled
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    {locale === "pt-BR" ? "Definido no app.yaml" : "Defined in app.yaml"}
                  </p>
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {locale === "pt-BR" ? "Modelo de Embedding" : "Embedding Model"}
                    </label>
                    <select
                      value={generalConfig.embeddingModel}
                      onChange={(e) => handleGeneralConfigChange("embeddingModel", e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)]"
                    >
                      <option value="databricks-gte-large-en">databricks-gte-large-en</option>
                      <option value="databricks-bge-large-en">databricks-bge-large-en</option>
                    </select>
                    <p className="mt-1 text-xs text-gray-500">
                      {locale === "pt-BR" ? "Modelo para gerar os vetores" : "Model to generate vectors"}
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {locale === "pt-BR" ? "Sincronização do Índice" : "Index Synchronization"}
                    </label>
                    <select
                      value={generalConfig.indexSyncType}
                      onChange={(e) => handleGeneralConfigChange("indexSyncType", e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)]"
                    >
                      <option value="TRIGGERED">{locale === "pt-BR" ? "Manual (sob demanda)" : "Manual (on demand)"}</option>
                      <option value="CONTINUOUS">{locale === "pt-BR" ? "Contínuo (automático)" : "Continuous (automatic)"}</option>
                    </select>
                    <p className="mt-1 text-xs text-gray-500">
                      {locale === "pt-BR" ? "Como o índice será atualizado" : "How the index will be updated"}
                    </p>
                  </div>
                </div>
                
                {/* Index Preview */}
                <div className="mt-4 p-3 bg-[var(--color-success-light)] rounded-lg">
                  <p className="text-xs font-medium text-[var(--color-success)] mb-2">
                    {locale === "pt-BR" ? "Índice que será criado:" : "Index that will be created:"}
                  </p>
                  <code className="text-xs bg-white px-2 py-1 rounded border border-[var(--color-success-lighter)]">
                    {generalConfig.catalog}.{generalConfig.schema}.{generalConfig.tableName}_vs
                  </code>
                </div>
              </div>
            </div>
          )}
          
          {/* Appearance Tab */}
          {activeTab === "appearance" && (
            <div>
              {/* Sub-tabs for Appearance */}
              <div className="flex gap-2 mb-4 p-1 bg-gray-100 rounded-lg">
                <button
                  onClick={() => setAppearanceSubTab("identity")}
                  className={`flex-1 px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                    appearanceSubTab === "identity" 
                      ? "bg-white text-gray-900 shadow-sm" 
                      : "text-gray-600 hover:text-gray-900"
                  }`}
                >
                  {locale === "pt-BR" ? "Identidade" : "Identity"}
                </button>
                <button
                  onClick={() => setAppearanceSubTab("colors")}
                  className={`flex-1 px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                    appearanceSubTab === "colors" 
                      ? "bg-white text-gray-900 shadow-sm" 
                      : "text-gray-600 hover:text-gray-900"
                  }`}
                >
                  {locale === "pt-BR" ? "Cores" : "Colors"}
                </button>
              </div>
              
              {/* Identity Sub-tab */}
              {appearanceSubTab === "identity" && (
                <>
                  {/* AI Assistant Button */}
                  <div className="mb-6 p-4 bg-gradient-to-r from-purple-50 to-indigo-50 rounded-lg border border-purple-100">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                          <Sparkles className="h-4 w-4 text-purple-600" />
                          {locale === "pt-BR" ? "Assistente AI" : "AI Assistant"}
                        </h3>
                        <p className="text-xs text-gray-600 mt-1">
                          {locale === "pt-BR" 
                            ? "Gere cores automaticamente com base no nome da empresa" 
                            : "Auto-generate colors based on company name"}
                        </p>
                      </div>
                      <button
                        onClick={() => setShowAIAssistant(!showAIAssistant)}
                        className="px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-purple-500 to-indigo-600 rounded-lg hover:from-purple-600 hover:to-indigo-700 transition-all flex items-center gap-2"
                      >
                        <Sparkles className="h-4 w-4" />
                        {locale === "pt-BR" ? "Usar AI" : "Use AI"}
                      </button>
                    </div>
                  </div>
                  
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

                  {/* Logo URL with Preview */}
                  <div className="mb-6">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      {locale === "pt-BR" ? "URL do Logo (opcional)" : "Logo URL (optional)"}
                    </label>
                    <div className="flex gap-3">
                      {/* Logo Preview */}
                      <div className="flex-shrink-0 w-16 h-16 border border-gray-200 rounded-lg bg-gray-50 flex items-center justify-center overflow-hidden">
                        {localTheme.logo_url && !logoError ? (
                          <img
                            src={localTheme.logo_url}
                            alt="Logo preview"
                            className="max-w-full max-h-full object-contain"
                            onError={() => setLogoError(true)}
                            onLoad={() => setLogoError(false)}
                          />
                        ) : localTheme.logo_url && logoError ? (
                          <span className="text-[10px] text-red-500 text-center px-1">
                            {locale === "pt-BR" ? "URL inválida" : "Invalid URL"}
                          </span>
                        ) : (
                          <span className="text-[10px] text-gray-400 text-center px-1">
                            {locale === "pt-BR" ? "Sem logo" : "No logo"}
                          </span>
                        )}
                      </div>
                      {/* Input and Clear */}
                      <div className="flex-1">
                        <div className="flex gap-2">
                          <input
                            type="url"
                            value={localTheme.logo_url}
                            onChange={(e) => {
                              setLocalTheme(prev => ({ ...prev, logo_url: e.target.value }))
                              setLogoError(false)
                              setHasChanges(true)
                            }}
                            placeholder="https://example.com/logo.png"
                            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)]"
                          />
                          {localTheme.logo_url && (
                            <button
                              type="button"
                              onClick={() => {
                                setLocalTheme(prev => ({ ...prev, logo_url: "" }))
                                setLogoError(false)
                                setHasChanges(true)
                              }}
                              className="px-3 py-2 text-sm text-gray-600 hover:text-red-600 border border-gray-300 rounded-lg hover:border-red-300 transition-colors"
                              title={locale === "pt-BR" ? "Remover logo" : "Remove logo"}
                            >
                              <X className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-gray-500">
                          {locale === "pt-BR" 
                            ? "Deixe vazio para usar o logo padrão do Databricks" 
                            : "Leave empty to use default Databricks logo"}
                        </p>
                      </div>
                    </div>
                  </div>
                  
                  {/* Preview */}
                  <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
                      {locale === "pt-BR" ? "Prévia" : "Preview"}
                    </p>
                    <div className="flex items-center gap-3">
                      {localTheme.logo_url && !logoError ? (
                        <img src={localTheme.logo_url} alt="Logo" className="h-8 w-8 object-contain" />
                      ) : (
                        <div className="h-8 w-8 bg-gray-200 rounded flex items-center justify-center text-xs text-gray-400">Logo</div>
                      )}
                      <span className="text-lg font-bold" style={{ color: localTheme.text_color }}>
                        {localTheme.app_name || "Contracts App"}
                      </span>
                    </div>
                  </div>
                </>
              )}
              
              {/* Colors Sub-tab */}
              {appearanceSubTab === "colors" && (
                <>
                  {/* Main Colors */}
                  <div className="mb-4">
                    <h3 className="text-sm font-medium text-gray-700 mb-3">
                      {locale === "pt-BR" ? "Cores Principais" : "Main Colors"}
                    </h3>
                <div className="grid grid-cols-2 gap-3">
                  {mainColorFields.map((field) => (
                    <div key={field.key} className="bg-gray-50 rounded-lg p-3">
                      <div className="flex items-center gap-3 mb-2">
                        <input
                          type="color"
                          value={(localTheme[field.key as keyof typeof localTheme] as string) || "#000000"}
                          onChange={(e) => handleColorChange(field.key, e.target.value)}
                          className="w-8 h-8 rounded-lg border border-gray-300 cursor-pointer"
                          style={{ padding: 0 }}
                        />
                        <div>
                          <p className="text-xs font-medium text-gray-900">{field.label}</p>
                          <p className="text-[10px] text-gray-500">{field.description}</p>
                        </div>
                      </div>
                      <input
                        type="text"
                        value={(localTheme[field.key as keyof typeof localTheme] as string) || ""}
                        onChange={(e) => handleColorChange(field.key, e.target.value)}
                        className="w-full px-2 py-1 text-xs font-mono border border-gray-200 rounded bg-white"
                        placeholder="#FFFFFF"
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Derived Colors (Backgrounds) */}
              <div className="mb-4">
                <h3 className="text-sm font-medium text-gray-700 mb-2">
                  {locale === "pt-BR" ? "Cores de Fundo" : "Background Colors"}
                </h3>
                <p className="text-xs text-gray-500 mb-3">
                  {locale === "pt-BR" 
                    ? "Estas cores são geradas automaticamente mas podem ser ajustadas manualmente." 
                    : "These colors are auto-generated but can be manually adjusted."}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {derivedColorFields.map((field) => (
                    <div key={field.key} className="bg-gray-50 rounded-lg p-2">
                      <div className="flex items-center gap-2 mb-1">
                        <input
                          type="color"
                          value={(localTheme[field.key as keyof typeof localTheme] as string) || "#FFFFFF"}
                          onChange={(e) => {
                            setLocalTheme(prev => ({ ...prev, [field.key]: e.target.value }))
                            setHasChanges(true)
                          }}
                          className="w-6 h-6 rounded border border-gray-300 cursor-pointer"
                          style={{ padding: 0 }}
                        />
                        <div>
                          <p className="text-[10px] font-medium text-gray-900">{field.label}</p>
                        </div>
                      </div>
                      <input
                        type="text"
                        value={(localTheme[field.key as keyof typeof localTheme] as string) || ""}
                        onChange={(e) => {
                          setLocalTheme(prev => ({ ...prev, [field.key]: e.target.value }))
                          setHasChanges(true)
                        }}
                        className="w-full px-1.5 py-0.5 text-[10px] font-mono border border-gray-200 rounded bg-white"
                        placeholder="#FFFFFF"
                      />
                    </div>
                  ))}
                  </div>
                </div>

                {/* Colors Preview */}
                <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
                    {locale === "pt-BR" ? "Prévia" : "Preview"}
                  </p>
                  <div className="space-y-3">
                    {/* Buttons and text */}
                    <div className="flex items-center gap-3 flex-wrap">
                      <button
                        className="px-3 py-1.5 text-xs font-medium text-white rounded-lg"
                        style={{ backgroundColor: localTheme.primary_color }}
                      >
                        {locale === "pt-BR" ? "Botão" : "Button"}
                      </button>
                      <span 
                        className="text-xs font-semibold"
                        style={{ color: localTheme.text_color }}
                      >
                        {locale === "pt-BR" ? "Texto" : "Text"}
                      </span>
                      <span 
                        className="text-xs font-medium"
                        style={{ color: localTheme.success_color }}
                      >
                        {locale === "pt-BR" ? "Sucesso" : "Success"}
                      </span>
                      <span 
                        className="text-xs font-medium"
                        style={{ color: localTheme.accent_color }}
                      >
                        {locale === "pt-BR" ? "Info" : "Info"}
                      </span>
                      <span 
                        className="text-xs font-medium"
                        style={{ color: localTheme.warning_color || "#F59E0B" }}
                      >
                        {locale === "pt-BR" ? "Alerta" : "Warning"}
                      </span>
                    </div>
                    {/* Background boxes */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <div 
                        className="px-2 py-1 rounded text-[10px]"
                        style={{ 
                          backgroundColor: localTheme.primary_light || "#FFEBE8",
                          color: localTheme.primary_color
                        }}
                      >
                        {locale === "pt-BR" ? "Fundo Primário" : "Primary BG"}
                      </div>
                      <div 
                        className="px-2 py-1 rounded text-[10px]"
                        style={{ 
                          backgroundColor: localTheme.success_light || "#E6F7F1",
                          color: localTheme.success_color
                        }}
                      >
                        {locale === "pt-BR" ? "Fundo Sucesso" : "Success BG"}
                      </div>
                      <div 
                        className="px-2 py-1 rounded text-[10px]"
                        style={{ 
                          backgroundColor: localTheme.accent_light || "#E8EEF7",
                          color: localTheme.accent_color
                        }}
                      >
                        {locale === "pt-BR" ? "Fundo Info" : "Info BG"}
                      </div>
                      <div 
                        className="px-2 py-1 rounded text-[10px]"
                        style={{ 
                          backgroundColor: localTheme.warning_light || "#FEF3C7",
                          color: localTheme.warning_color || "#F59E0B"
                        }}
                      >
                        {locale === "pt-BR" ? "Fundo Alerta" : "Warning BG"}
                      </div>
                    </div>
                  </div>
                </div>
                </>
              )}
            </div>
          )}
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
