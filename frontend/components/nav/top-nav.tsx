"use client"

import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState, useRef, useEffect } from "react"
import { Globe, ChevronDown, Check } from "lucide-react"
import databricksLogo from "@/app/assets/databricks.png"
import { useTranslation, Locale } from "@/lib/i18n"

export function TopNav() {
  const pathname = usePathname()
  const { locale, setLocale, t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  
  const navItems = [
    { href: "/import", labelKey: "app.nav.import" },
    { href: "/prepare", labelKey: "app.nav.prepare" },
  ]

  const languages: { code: Locale; label: string }[] = [
    { code: "en", label: "English" },
    { code: "pt-BR", label: "Português" },
  ]

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const handleLanguageChange = (code: Locale) => {
    setLocale(code)
    setIsOpen(false)
  }
  
  return (
    <nav className="border-b bg-white shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16">
          <div className="flex">
            <div className="flex-shrink-0 flex items-center gap-3">
              <Image
                src={databricksLogo}
                alt="Databricks"
                width={32}
                height={32}
                className="h-8 w-auto"
                priority
              />
              <span className="text-xl font-bold text-[#1B1B1D]">
                {t("app.name")}
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
                    className={`inline-flex items-center px-2 py-2 text-sm transition-all duration-200 ${
                      isActive
                        ? "text-[#FF3621] font-bold"
                        : "text-gray-600 font-medium hover:text-[#FF3621]"
                    }`}
                  >
                    {t(item.labelKey)}
                  </Link>
                )
              })}
            </div>
          </div>

          <div className="flex items-center">
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-600 hover:text-[#FF3621] transition-colors rounded-lg hover:bg-gray-50"
                aria-label={t("language.select")}
              >
                <Globe className="h-4 w-4" />
                <span className="hidden sm:inline">
                  {languages.find(l => l.code === locale)?.label}
                </span>
                <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`} />
              </button>

              {isOpen && (
                <div className="absolute right-0 mt-2 w-40 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
                  {languages.map((lang) => (
                    <button
                      key={lang.code}
                      onClick={() => handleLanguageChange(lang.code)}
                      className={`w-full flex items-center justify-between px-4 py-2 text-sm transition-colors ${
                        locale === lang.code
                          ? "text-[#FF3621] bg-red-50 font-medium"
                          : "text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      <span>{lang.label}</span>
                      {locale === lang.code && <Check className="h-4 w-4" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </nav>
  )
}
