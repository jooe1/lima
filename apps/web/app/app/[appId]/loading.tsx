import { RouteStateScreen } from '../../_components/RouteStateScreen'

export default function RuntimeLoading() {
  return (
    <RouteStateScreen
      title="Loading tool…"
      body="Fetching the latest version of this tool."
    />
  )
}
