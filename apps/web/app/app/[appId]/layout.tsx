/**
 * Runtime shell — no extra chrome; the page itself renders the header.
 */
export default function RuntimeLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
