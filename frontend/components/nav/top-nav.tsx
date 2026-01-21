"use client"

import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import databricksLogo from "@/app/assets/databricks.png"

export function TopNav() {
  const pathname = usePathname()
  
  const navItems = [
    { href: "/import", label: "Importar Documentos" },
    { href: "/prepare", label: "Preparar dados para busca" },
  ]
  
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
                Contracts App
              </span>
            </div>
            <div className="hidden sm:ml-8 sm:flex sm:space-x-2">
              {navItems.map((item) => {
                // Check if current path matches or starts with the nav item href
                const isActive = pathname === item.href || 
                                 pathname === `${item.href}/` || 
                                 pathname?.startsWith(`${item.href}/`)
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`inline-flex items-center px-4 py-2 text-sm font-medium rounded-lg transition-all duration-200 ${
                      isActive
                        ? "bg-[#FF3621] text-white shadow-sm"
                        : "text-gray-700 hover:bg-gray-100 hover:text-[#FF3621]"
                    }`}
                  >
                    {item.label}
                  </Link>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </nav>
  )
}
