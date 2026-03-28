import { RouteStateScreen } from './_components/RouteStateScreen'

export default function NotFound() {
  return (
    <RouteStateScreen
      title="Page not found"
      body="The page you're looking for doesn't exist or has been moved."
      actionHref="/"
      actionLabel="Go to home"
    />
  )
}
