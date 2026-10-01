import React from 'react'
import { RefreshCw } from 'lucide-react'
import Modal from '../../apps/desktop/src/renderer/src/components/Modal'
import IconButton from '../../apps/desktop/src/renderer/src/components/IconButton'
import EmptyState from '../../apps/desktop/src/renderer/src/components/EmptyState'
import CodeEditor from '../../apps/desktop/src/renderer/src/components/CodeEditor'
import { AppFormSection } from '../../apps/desktop/src/renderer/src/components/FormPrimitives'

export default function SharedChromeFixture() {
  return <Modal title="共享外观检查" subtitle="长标题与说明" size="lg" hint="保留当前说明排版、空态及键盘操作，不连接真实资料库。"
    onCancel={() => { window.sharedChromeAction = 'cancel' }}
    onConfirm={() => { window.sharedChromeAction = 'save' }}>
    <AppFormSection title="字段分组" hint="这段文字保持原有密度。"
      actions={<IconButton icon={<RefreshCw size={16} />} label="刷新分组" onClick={() => { window.sharedChromeAction = 'refresh' }} />}>
      <EmptyState variant="compact" title="暂无资料" icon={<RefreshCw size={20} />}
        description="导入后可继续编辑。" />
      <CodeEditor value="const title = '保留代码高亮';" disabled onChange={() => {}} />
    </AppFormSection>
  </Modal>
}
