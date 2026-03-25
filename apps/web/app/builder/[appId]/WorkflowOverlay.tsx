'use client'

import React from 'react'
import { type AuraNode } from '@lima/aura-dsl'
import { WorkflowCanvas } from './WorkflowCanvas'

export interface WorkflowOverlayProps {
  workflowId: string
  workspaceId: string
  appId: string
  pageId: string
  onClose: () => void
  onPopOut?: (workflowId: string) => void
  pageDocument: AuraNode[]
  isAdmin: boolean
}

const BORDER = '#1e1e1e'
const BG = '#060606'

export function WorkflowOverlay({
  workflowId,
  workspaceId,
  appId,
  pageId,
  onClose,
  pageDocument,
  isAdmin,
}: WorkflowOverlayProps) {
  return (
    <div
      style={{
        position: 'fixed',
        right: 0,
        top: 0,
        bottom: 0,
        width: 'clamp(480px, 50vw, 720px)',
        zIndex: 1001,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: `1px solid ${BORDER}`,
        boxShadow: '-6px 0 32px rgba(0,0,0,0.6)',
        background: BG,
      }}
    >
      {/*
        transform: translateZ(0) creates a new stacking context and a new
        containing block for position:fixed descendants. This constrains
        WorkflowCanvas's own position:fixed layout to fill this panel only.
      */}
      <div
        style={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          transform: 'translateZ(0)',
        }}
      >
        <WorkflowCanvas
          workspaceId={workspaceId}
          appId={appId}
          workflowId={workflowId}
          triggerLabel="Trigger"
          onClose={onClose}
          isAdmin={isAdmin}
          pageId={pageId}
          pageDocument={pageDocument}
        />
      </div>
    </div>
  )
}
