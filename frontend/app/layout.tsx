import type { Metadata } from "next";
import { DM_Sans, DM_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { I18nProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import "./globals.css";

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
});

const dmMono = DM_Mono({
  variable: "--font-dm-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Databricks Contracts App",
  description: "Manage and analyze your contracts with Databricks",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${dmSans.variable} ${dmMono.variable} font-sans antialiased`}
      >
        <I18nProvider>
          <ThemeProvider>
            {children}
            <Toaster 
              position="top-right" 
              richColors 
              closeButton
              duration={6000}
              toastOptions={{
                style: {
                  padding: '16px',
                },
              }}
            />
          </ThemeProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
