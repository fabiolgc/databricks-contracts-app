"use client"

import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react"

import enCommon from "@/locales/en/common.json"
import ptBRCommon from "@/locales/pt-BR/common.json"

export type Locale = "en" | "pt-BR"

const translations: Record<Locale, typeof enCommon> = {
  "en": enCommon,
  "pt-BR": ptBRCommon
}

interface I18nContextType {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: string, params?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextType | null>(null)

const STORAGE_KEY = "databricks-contracts-app-locale"

function getNestedValue(obj: Record<string, unknown>, path: string): string | undefined {
  const keys = path.split(".")
  let result: unknown = obj
  
  for (const key of keys) {
    if (result && typeof result === "object" && key in result) {
      result = (result as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  
  return typeof result === "string" ? result : undefined
}

function detectBrowserLocale(): Locale {
  if (typeof window === "undefined") return "en"
  
  const browserLang = navigator.language || (navigator as { userLanguage?: string }).userLanguage || "en"
  
  if (browserLang.startsWith("pt")) {
    return "pt-BR"
  }
  
  return "en"
}

function getSavedLocale(): Locale | null {
  if (typeof window === "undefined") return null
  
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === "en" || saved === "pt-BR") {
      return saved
    }
  } catch {
    // localStorage not available
  }
  
  return null
}

function saveLocale(locale: Locale): void {
  if (typeof window === "undefined") return
  
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // localStorage not available
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en")
  const [isHydrated, setIsHydrated] = useState(false)

  useEffect(() => {
    const saved = getSavedLocale()
    if (saved) {
      setLocaleState(saved)
    } else {
      const detected = detectBrowserLocale()
      setLocaleState(detected)
      saveLocale(detected)
    }
    setIsHydrated(true)
  }, [])

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale)
    saveLocale(newLocale)
  }, [])

  const t = useCallback((key: string, params?: Record<string, string | number>): string => {
    const translation = getNestedValue(translations[locale] as Record<string, unknown>, key)
    
    if (!translation) {
      console.warn(`[i18n] Missing translation: ${key}`)
      return key
    }
    
    if (params) {
      return translation.replace(/\{(\w+)\}/g, (_, paramKey) => {
        return params[paramKey]?.toString() ?? `{${paramKey}}`
      })
    }
    
    return translation
  }, [locale])

  if (!isHydrated) {
    return null
  }

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useTranslation() {
  const context = useContext(I18nContext)
  
  if (!context) {
    throw new Error("useTranslation must be used within an I18nProvider")
  }
  
  return context
}

export function useLocale(): Locale {
  const { locale } = useTranslation()
  return locale
}
