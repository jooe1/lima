import type { WorkflowStepInput, WorkflowStepType } from '../../../lib/api'

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  icon: string
  accentColor: string
  steps: WorkflowStepInput[]
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'read-display',
    name: 'Read & Display',
    description: 'Fetch records from a table and show them in the app',
    icon: '📋',
    accentColor: '#1e3a8a',
    steps: [
      {
        name: 'Read data',
        step_type: 'query' as WorkflowStepType,
        config: { connector_id: '', sql: '' },
        ai_generated: false,
      },
    ],
  },
  {
    id: 'insert-record',
    name: 'Insert Record',
    description: 'Add a new row to a database table from a form',
    icon: '💾',
    accentColor: '#7c2d12',
    steps: [
      {
        name: 'Save to database',
        step_type: 'mutation' as WorkflowStepType,
        config: { connector_id: '', operation: 'insert', table: '' },
        ai_generated: false,
      },
    ],
  },
  {
    id: 'read-then-write',
    name: 'Read then Write',
    description: 'Look up existing data, then update or insert based on results',
    icon: '🔄',
    accentColor: '#065f46',
    steps: [
      {
        name: 'Read existing data',
        step_type: 'query' as WorkflowStepType,
        config: { connector_id: '', sql: '' },
        ai_generated: false,
      },
      {
        name: 'Update record',
        step_type: 'mutation' as WorkflowStepType,
        config: { connector_id: '', operation: 'update', table: '' },
        ai_generated: false,
      },
    ],
  },
  {
    id: 'approval-required',
    name: 'Approval Required',
    description: 'Submit data for manager review before writing to the database',
    icon: '✅',
    accentColor: '#4c1d95',
    steps: [
      {
        name: 'Require approval',
        step_type: 'approval_gate' as WorkflowStepType,
        config: { description: 'Please review and approve before the data is saved.' },
        ai_generated: false,
      },
      {
        name: 'Save to database',
        step_type: 'mutation' as WorkflowStepType,
        config: { connector_id: '', operation: 'insert', table: '' },
        ai_generated: false,
      },
    ],
  },
  {
    id: 'notify-and-write',
    name: 'Write & Notify',
    description: 'Save data to the database and send a notification',
    icon: '🔔',
    accentColor: '#064e3b',
    steps: [
      {
        name: 'Save to database',
        step_type: 'mutation' as WorkflowStepType,
        config: { connector_id: '', operation: 'insert', table: '' },
        ai_generated: false,
      },
      {
        name: 'Send notification',
        step_type: 'notification' as WorkflowStepType,
        config: { message: '' },
        ai_generated: false,
      },
    ],
  },
]
