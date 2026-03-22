'use client'

import React from 'react'

interface DashboardFilterContextValue {
	values: Record<string, string>
	setFilterValue: (widgetId: string, value: string) => void
}

const DashboardFilterContext = React.createContext<DashboardFilterContextValue | null>(null)

export function DashboardFilterProvider({ children }: { children: React.ReactNode }) {
	const [values, setValues] = React.useState<Record<string, string>>({})

	const setFilterValue = React.useCallback((widgetId: string, value: string) => {
		setValues(prev => {
			if (!widgetId) return prev
			if (!value.trim()) {
				if (!(widgetId in prev)) return prev
				const next = { ...prev }
				delete next[widgetId]
				return next
			}
			if (prev[widgetId] === value) return prev
			return {
				...prev,
				[widgetId]: value,
			}
		})
	}, [])

	return (
		<DashboardFilterContext.Provider value={{ values, setFilterValue }}>
			{children}
		</DashboardFilterContext.Provider>
	)
}

export function useDashboardFilters() {
	const context = React.useContext(DashboardFilterContext)
	if (!context) {
		throw new Error('useDashboardFilters must be used within DashboardFilterProvider')
	}
	return context
}
