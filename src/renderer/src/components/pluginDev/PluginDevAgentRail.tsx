import type {
  PluginDevAgentContextStats,
  PluginDevAgentPhase,
  PluginDevDryRunResult,
  PluginExecutionArtifact,
  PluginRunAcceptanceOutcome,
  PluginDevPendingApproval,
  PluginDevPendingUserRequest,
  PluginDevSessionStatus
} from '@shared/pluginDevTypes'
import PluginDevConversation from './PluginDevConversation'
import PluginDevResultPanel from './PluginDevResultPanel'
import { agentPhaseLabel, type PluginDevAgentTab, type PluginDevConversationItem, type PluginKind } from './types'
import { WorkbenchRail, WorkbenchTabs } from '../workbench'

export default function PluginDevAgentRail({
  kind,
  tab,
  conversationCount,
  resultCount,
  agentStatus,
  agentPhase,
  agentStep,
  contextStats,
  activeTool,
  conversationItems,
  dryRun,
  execution,
  acceptance,
  resultStale,
  installState,
  waitingUserReason,
  artifactReady,
  pendingApproval,
  pendingUserRequest,
  feedbackText,
  busy,
  canSend,
  canCancelAgent,
  canClearHistory,
  clearHistoryBusy,
  canExportWorkLog,
  exportWorkLogBusy,
  onTabChange,
  onFeedbackChange,
  onSend,
  onCancelAgent,
  onClearHistory,
  onContinueBrowserInteraction,
  onFieldMapping,
  onApprovalDecision,
  onExportWorkLog
}: {
  kind: PluginKind
  tab: PluginDevAgentTab
  conversationCount: number
  resultCount: number
  agentStatus: PluginDevSessionStatus | null
  agentPhase: PluginDevAgentPhase
  agentStep: number
  contextStats: PluginDevAgentContextStats | null
  activeTool: string | null
  conversationItems: PluginDevConversationItem[]
  dryRun: PluginDevDryRunResult | null
  execution: PluginExecutionArtifact | null
  acceptance: PluginRunAcceptanceOutcome | null
  resultStale: boolean
  installState: 'not-installed' | 'dirty' | 'synced'
  waitingUserReason: string | null
  artifactReady: boolean
  pendingApproval: PluginDevPendingApproval | null
  pendingUserRequest: PluginDevPendingUserRequest | null
  feedbackText: string
  busy: boolean
  canSend: boolean
  canCancelAgent: boolean
  canClearHistory: boolean
  clearHistoryBusy: boolean
  canExportWorkLog: boolean
  exportWorkLogBusy: boolean
  onTabChange: (tab: PluginDevAgentTab) => void
  onFeedbackChange: (value: string) => void
  onSend: () => void
  onCancelAgent: () => void
  onClearHistory: () => void
  onContinueBrowserInteraction: () => void
  onFieldMapping: (optionId: string) => void
  onApprovalDecision: (decision: 'approve' | 'deny') => void
  onExportWorkLog: () => void
}): JSX.Element {
  const running = agentStatus === 'running' && busy
  const phaseItems: PluginDevAgentPhase[] = [
    'working',
    'checking',
    'ready'
  ]

  return (
    <WorkbenchRail className="plugin-dev-rail plugin-dev-rail--agent">
      <WorkbenchTabs
        id="plugin-dev-tab"
        label="Agent 面板"
        value={tab}
        className="plugin-dev-agent-tabs"
        items={[
          {
            id: 'conversation',
            label: <>对话{conversationCount > 0 && <span>{conversationCount}</span>}</>,
            panelId: 'plugin-dev-panel-conversation'
          },
          {
            id: 'result',
            label: <>结果{resultCount > 0 && <span>{resultCount}</span>}</>,
            panelId: 'plugin-dev-panel-result'
          }
        ]}
        onChange={onTabChange}
      />

      <div className="plugin-dev-agent-flow" aria-label="Agent 流程">
        <div className="plugin-dev-phase-track">
          {phaseItems.map((phase) => (
            <span
              key={phase}
              className={`plugin-dev-phase-chip ${agentPhase === phase ? 'is-active' : ''}`}
            >
              {agentPhaseLabel(phase)}
            </span>
          ))}
        </div>
      </div>

      <div className="plugin-dev-agent-body">
        <div
          id="plugin-dev-panel-conversation"
          className="plugin-dev-agent-pane"
          role="tabpanel"
          aria-labelledby="plugin-dev-tab-conversation"
          hidden={tab !== 'conversation'}
        >
          <PluginDevConversation
            visible={tab === 'conversation'}
            items={conversationItems}
            activeTool={activeTool}
            agentPhase={agentPhase}
            agentStep={agentStep}
            contextStats={contextStats}
            running={running}
            feedbackText={feedbackText}
            agentStatus={agentStatus}
            busy={busy}
            canSend={canSend}
            canCancelAgent={canCancelAgent}
            canClearHistory={canClearHistory}
            clearHistoryBusy={clearHistoryBusy}
            canExportWorkLog={canExportWorkLog}
            exportWorkLogBusy={exportWorkLogBusy}
            waitingUserReason={waitingUserReason}
            artifactReady={artifactReady}
            pendingApproval={pendingApproval}
            pendingUserRequest={pendingUserRequest}
            onFeedbackChange={onFeedbackChange}
            onSend={onSend}
            onCancelAgent={onCancelAgent}
            onClearHistory={onClearHistory}
            onContinueBrowserInteraction={onContinueBrowserInteraction}
            onFieldMapping={onFieldMapping}
            onApprovalDecision={onApprovalDecision}
            onExportWorkLog={onExportWorkLog}
          />
        </div>
        <div
          id="plugin-dev-panel-result"
          className="plugin-dev-agent-pane"
          role="tabpanel"
          aria-labelledby="plugin-dev-tab-result"
          hidden={tab !== 'result'}
        >
          <PluginDevResultPanel
            kind={kind}
            dryRun={dryRun}
            execution={execution}
            acceptance={acceptance}
            stale={resultStale}
            installState={installState}
          />
        </div>
      </div>
    </WorkbenchRail>
  )
}
