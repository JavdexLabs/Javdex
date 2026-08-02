import type {
  PluginDevAgentContextStats,
  PluginDevAgentPhase,
  PluginDevDryRunResult,
  PluginDevSessionStatus,
  PluginDevVerificationReport
} from '@shared/types'
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
  verification,
  resultStale,
  installState,
  waitingUserReason,
  feedbackText,
  busy,
  canSend,
  canCancelAgent,
  canExportWorkLog,
  exportWorkLogBusy,
  onTabChange,
  onFeedbackChange,
  onSend,
  onCancelAgent,
  onContinueChallenge,
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
  verification: PluginDevVerificationReport | null
  resultStale: boolean
  installState: 'not-installed' | 'dirty' | 'synced'
  waitingUserReason: string | null
  feedbackText: string
  busy: boolean
  canSend: boolean
  canCancelAgent: boolean
  canExportWorkLog: boolean
  exportWorkLogBusy: boolean
  onTabChange: (tab: PluginDevAgentTab) => void
  onFeedbackChange: (value: string) => void
  onSend: () => void
  onCancelAgent: () => void
  onContinueChallenge: () => void
  onExportWorkLog: () => void
}): JSX.Element {
  const running = agentStatus === 'running' && busy
  const phaseItems: PluginDevAgentPhase[] = [
    'discover',
    'implement',
    'dry_run',
    'verify',
    'finish'
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
            canExportWorkLog={canExportWorkLog}
            exportWorkLogBusy={exportWorkLogBusy}
            waitingUserReason={waitingUserReason}
            onFeedbackChange={onFeedbackChange}
            onSend={onSend}
            onCancelAgent={onCancelAgent}
            onContinueChallenge={onContinueChallenge}
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
            verification={verification}
            stale={resultStale}
            installState={installState}
          />
        </div>
      </div>
    </WorkbenchRail>
  )
}
