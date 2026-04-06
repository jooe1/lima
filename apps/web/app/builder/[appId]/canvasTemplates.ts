import type { AuraNode } from '@lima/aura-dsl'

export interface CanvasTemplate {
  id: string
  name: string
  description: string
  icon: string
  accentColor: string
  /** Pre-built AuraNode array loaded onto the canvas when this template is chosen. */
  nodes: AuraNode[]
}

export const CANVAS_TEMPLATES: CanvasTemplate[] = [
  // ------------------------------------------------------------------
  // 1. Data table + filters
  // ------------------------------------------------------------------
  {
    id: 'data-table-filters',
    name: 'Data table + filters',
    description: 'Search bar above a full-width data table ready for a connector query',
    icon: '⊞',
    accentColor: '#1e3a8a',
    nodes: [
      {
        element: 'text',
        id: 'text1',
        parentId: 'root',
        text: 'Records',
        style: { gridX: '0', gridY: '0', gridW: '16', gridH: '2', variant: 'heading1' },
      },
      {
        element: 'filter',
        id: 'filter1',
        parentId: 'root',
        text: 'Search',
        style: { gridX: '0', gridY: '2', gridW: '6', gridH: '2', placeholder: 'Type to filter…' },
      },
      {
        element: 'table',
        id: 'table1',
        parentId: 'root',
        style: { gridX: '0', gridY: '5', gridW: '20', gridH: '8' },
      },
    ],
  },

  // ------------------------------------------------------------------
  // 2. KPI dashboard
  // ------------------------------------------------------------------
  {
    id: 'kpi-dashboard',
    name: 'KPI dashboard',
    description: 'Four metric tiles in a row with a supporting bar chart below',
    icon: '📊',
    accentColor: '#065f46',
    nodes: [
      {
        element: 'text',
        id: 'text1',
        parentId: 'root',
        text: 'Analytics Overview',
        style: { gridX: '0', gridY: '0', gridW: '20', gridH: '2', variant: 'heading1' },
      },
      {
        element: 'kpi',
        id: 'kpi1',
        parentId: 'root',
        text: 'Total',
        value: '0',
        style: { gridX: '0', gridY: '3', gridW: '4', gridH: '3' },
      },
      {
        element: 'kpi',
        id: 'kpi2',
        parentId: 'root',
        text: 'Active',
        value: '0',
        style: { gridX: '5', gridY: '3', gridW: '4', gridH: '3' },
      },
      {
        element: 'kpi',
        id: 'kpi3',
        parentId: 'root',
        text: 'Pending',
        value: '0',
        style: { gridX: '10', gridY: '3', gridW: '4', gridH: '3' },
      },
      {
        element: 'kpi',
        id: 'kpi4',
        parentId: 'root',
        text: 'Closed',
        value: '0',
        style: { gridX: '15', gridY: '3', gridW: '4', gridH: '3' },
      },
      {
        element: 'chart',
        id: 'chart1',
        parentId: 'root',
        style: { gridX: '0', gridY: '7', gridW: '20', gridH: '8' },
      },
    ],
  },

  // ------------------------------------------------------------------
  // 3. Approval form
  // ------------------------------------------------------------------
  {
    id: 'approval-form',
    name: 'Approval form',
    description: 'Submission form gated by an approval workflow before writing data',
    icon: '✅',
    accentColor: '#4c1d95',
    nodes: [
      {
        element: 'text',
        id: 'text1',
        parentId: 'root',
        text: 'Submit Request',
        style: { gridX: '0', gridY: '0', gridW: '12', gridH: '2', variant: 'heading1' },
      },
      {
        element: 'text',
        id: 'text2',
        parentId: 'root',
        text: 'Fill in the details below. Your submission will be sent to an approver before any data is saved.',
        style: { gridX: '0', gridY: '2', gridW: '12', gridH: '2', variant: 'body' },
      },
      {
        element: 'form',
        id: 'form1',
        parentId: 'root',
        style: {
          gridX: '0',
          gridY: '5',
          gridW: '8',
          gridH: '10',
          fields: 'name,email,notes',
          submitLabel: 'Submit for approval',
        },
      },
    ],
  },

  // ------------------------------------------------------------------
  // 4. Blank canvas
  // ------------------------------------------------------------------
  {
    id: 'blank',
    name: 'Blank canvas',
    description: 'Start from scratch and build your own layout',
    icon: '⬜',
    accentColor: '#374151',
    nodes: [],
  },
]
