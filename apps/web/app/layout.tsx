import type { Metadata } from 'next'
import './globals.css'
import { AuthProvider } from '../lib/auth'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages } from 'next-intl/server'

export const metadata: Metadata = {
  title: 'Lima',
  description: 'AI-first internal tools platform',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const messages = await getMessages()
  return (
    <html lang="en">
      <body>
        <NextIntlClientProvider messages={messages}>
          <AuthProvider>{children}</AuthProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
