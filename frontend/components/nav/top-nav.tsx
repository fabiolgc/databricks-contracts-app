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
            <div className="hidden sm:ml-8 sm:flex sm:space-x-8">
              {navItems.map((item) => {
                const isActive = pathname === item.href
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`inline-flex items-center px-1 pt-1 text-sm font-medium border-b-2 transition-colors ${
                      isActive
                        ? "border-[#FF3621] text-[#FF3621]"
                        : "border-transparent text-gray-700 hover:border-gray-300 hover:text-gray-900"
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
