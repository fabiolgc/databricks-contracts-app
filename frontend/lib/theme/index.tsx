"use client"

import React, { createContext, useContext, useEffect, useState, useCallback } from "react"

// Helper functions to generate color variations - exported for use in settings
export function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result 
    ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)]
    : [0, 0, 0]
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(x => {
    const hex = Math.round(x).toString(16)
    return hex.length === 1 ? '0' + hex : hex
  }).join('')
}

export function lightenColor(hex: string, factor: number): string {
  const [r, g, b] = hexToRgb(hex)
  const newR = r + (255 - r) * factor
  const newG = g + (255 - g) * factor
  const newB = b + (255 - b) * factor
  return rgbToHex(newR, newG, newB)
}

// Default theme colors (Databricks brand)
const DEFAULT_THEME = {
  primary_color: "#FF3621",    // Databricks red
  text_color: "#1B1B1D",       // Dark text
  success_color: "#00A972",    // Green (completed)
  accent_color: "#1857B6",     // Blue (processing)
  warning_color: "#F59E0B",    // Orange (warning)
  error_color: "#DC2626",      // Red (error)
  logo_url: "",                // Empty = use default
  app_name: "Contracts App",
  // Derived colors
  primary_light: "#FFEBE8",
  primary_lighter: "#FFD5CF",
  success_light: "#E6F7F1",
  success_lighter: "#CCF0E3",
  accent_light: "#E8EEF7",
  accent_lighter: "#D1DEEF",
  warning_light: "#FEF3C7",
  error_light: "#FEE2E2"
}

export interface ThemeConfig {
  primary_color: string
  text_color: string
  success_color: string      // Green - completed states
  accent_color: string       // Blue - processing states
  warning_color?: string     // Orange - warning states
  error_color?: string       // Red - error states
  logo_url: string
  app_name: string
  // Derived colors
  primary_light?: string
  primary_lighter?: string
  success_light?: string
  success_lighter?: string
  accent_light?: string
  accent_lighter?: string
  warning_light?: string
  error_light?: string
}

interface ThemeContextType {
  theme: ThemeConfig
  isLoading: boolean
  updateTheme: (newTheme: Partial<ThemeConfig>) => Promise<void>
  resetTheme: () => Promise<void>
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

// Color definitions for the settings UI
export const COLOR_DEFINITIONS = [
  {
    key: "primary_color",
    label: {
      en: "Primary Color",
      "pt-BR": "Cor Primária"
    },
    description: {
      en: "Main brand color used for buttons, links, and highlights",
      "pt-BR": "Cor principal usada em botões, links e destaques"
    }
  },
  {
    key: "text_color",
    label: {
      en: "Text Color",
      "pt-BR": "Cor do Texto"
    },
    description: {
      en: "Color used for headings and important text",
      "pt-BR": "Cor usada em títulos e textos importantes"
    }
  },
  {
    key: "success_color",
    label: {
      en: "Success Color",
      "pt-BR": "Cor de Sucesso"
    },
    description: {
      en: "Color used for success states and confirmations",
      "pt-BR": "Cor usada para estados de sucesso e confirmações"
    }
  },
  {
    key: "accent_color",
    label: {
      en: "Accent Color",
      "pt-BR": "Cor de Destaque"
    },
    description: {
      en: "Secondary color used for information and accents",
      "pt-BR": "Cor secundária usada para informações e acentos"
    }
  }
]

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<ThemeConfig>(DEFAULT_THEME)
  const [isLoading, setIsLoading] = useState(true)

  // Generate derived colors if not provided
  const generateDerivedColors = useCallback((config: ThemeConfig): ThemeConfig => {
    return {
      ...config,
      primary_light: config.primary_light || lightenColor(config.primary_color, 0.92),
      primary_lighter: config.primary_lighter || lightenColor(config.primary_color, 0.85),
      success_light: config.success_light || lightenColor(config.success_color, 0.92),
      success_lighter: config.success_lighter || lightenColor(config.success_color, 0.85),
      accent_light: config.accent_light || lightenColor(config.accent_color, 0.92),
      accent_lighter: config.accent_lighter || lightenColor(config.accent_color, 0.85),
      warning_color: config.warning_color || "#F59E0B",
      warning_light: config.warning_light || lightenColor(config.warning_color || "#F59E0B", 0.92),
      error_color: config.error_color || "#DC2626",
      error_light: config.error_light || lightenColor(config.error_color || "#DC2626", 0.92)
    }
  }, [])

  // Apply CSS variables whenever theme changes
  const applyCSSVariables = useCallback((config: ThemeConfig) => {
    const fullConfig = generateDerivedColors(config)
    const root = document.documentElement
    
    // Primary theme variables
    root.style.setProperty("--color-primary", fullConfig.primary_color)
    root.style.setProperty("--color-text", fullConfig.text_color)
    root.style.setProperty("--color-success", fullConfig.success_color)
    root.style.setProperty("--color-accent", fullConfig.accent_color)
    root.style.setProperty("--foreground", fullConfig.text_color)
    
    // Derived colors for backgrounds
    root.style.setProperty("--color-primary-light", fullConfig.primary_light!)
    root.style.setProperty("--color-primary-lighter", fullConfig.primary_lighter!)
    root.style.setProperty("--color-success-light", fullConfig.success_light!)
    root.style.setProperty("--color-success-lighter", fullConfig.success_lighter!)
    root.style.setProperty("--color-accent-light", fullConfig.accent_light!)
    root.style.setProperty("--color-accent-lighter", fullConfig.accent_lighter!)
    root.style.setProperty("--color-warning", fullConfig.warning_color!)
    root.style.setProperty("--color-warning-light", fullConfig.warning_light!)
    root.style.setProperty("--color-error", fullConfig.error_color!)
    root.style.setProperty("--color-error-light", fullConfig.error_light!)
  }, [generateDerivedColors])

  // Load theme from API on mount
  useEffect(() => {
    const loadTheme = async () => {
      try {
        const response = await fetch("/api/app-config")
        if (response.ok) {
          const data = await response.json()
          if (data.success && data.config) {
            const loadedTheme = { ...DEFAULT_THEME, ...data.config }
            setTheme(loadedTheme)
            applyCSSVariables(loadedTheme)
          }
        }
      } catch (error) {
        console.error("Error loading theme:", error)
        // Use defaults on error
        applyCSSVariables(DEFAULT_THEME)
      } finally {
        setIsLoading(false)
      }
    }
    loadTheme()
  }, [applyCSSVariables])

  // Update theme
  const updateTheme = useCallback(async (newTheme: Partial<ThemeConfig>) => {
    setIsLoading(true)
    try {
      const updatedTheme = { ...theme, ...newTheme }
      
      // Save to API
      const response = await fetch("/api/app-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newTheme)
      })
      
      if (response.ok) {
        setTheme(updatedTheme)
        applyCSSVariables(updatedTheme)
      } else {
        throw new Error("Failed to save theme")
      }
    } catch (error) {
      console.error("Error saving theme:", error)
      throw error
    } finally {
      setIsLoading(false)
    }
  }, [theme, applyCSSVariables])

  // Reset to defaults
  const resetTheme = useCallback(async () => {
    setIsLoading(true)
    try {
      await fetch("/api/app-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(DEFAULT_THEME)
      })
      
      setTheme(DEFAULT_THEME)
      applyCSSVariables(DEFAULT_THEME)
    } catch (error) {
      console.error("Error resetting theme:", error)
    } finally {
      setIsLoading(false)
    }
  }, [applyCSSVariables])

  return (
    <ThemeContext.Provider value={{ theme, isLoading, updateTheme, resetTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider")
  }
  return context
}
