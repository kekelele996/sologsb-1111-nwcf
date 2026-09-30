import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Modal,
  Radio,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { InboxOutlined, RetweetOutlined, CheckCircleOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { useReconcileStore } from '../stores/reconcileStore';
import { useBoxStore } from '../stores/boxStore';
import type { BoxConflict, FieldConflict } from '../types/reconcile';
import type { CoreBox } from '../types/core-box';
import { FIELD_LABELS } from '../utils/reconcile-engine';
import { downloadText } from '../utils/export';

const { Title, Paragraph, Text } = Typography;

/** 造一份能体现“两侧都动过 → 两版同留”的示例台账，便于试玩 */
function buildSampleLedger(boxes: CoreBox[]): string {
  const first = boxes[0];
  const rows: Array<Record<string, unknown>> = boxes.map((b) => ({
    boxNo: b.boxNo,
    holeId: b.holeId,
    shelfPos: b.shelfPos,
    loanStatus: b.loanStatus,
  }));
  if (first) {
    rows[0] = {
      ...rows[0],
      // 与现场可能不同的钻孔/深度（共有字段），制造需人工认领的两版分歧
      holeId: `${first.holeId}-库改`,
      shelfPos: 'C 区 1 架',
      loanStatus: '借出',
      loanTo: '第三方检测',
    };
  }
  return JSON.stringify(
    { app: 'store-ledger', batchId: `SAMPLE-${new Date().toISOString().slice(0, 10)}`, exportedAt: new Date().toISOString(), boxes: rows },
    null,
    2,
  );
}

function ValueView({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return <Text type="secondary">（空）</Text>;
  if (Array.isArray(value)) return value.length ? <Tag color="red">{value.join(', ')}</Tag> : <Text type="secondary">（空）</Text>;
  return <Text>{String(value)}</Text>;
}

/** 单条分歧的逐字段认领弹窗 */
function ResolveModal({ conflict, onClose }: { conflict: BoxConflict | null; onClose: () => void }) {
  const { message } = AntApp.useApp();
  const resolve = useReconcileStore((s) => s.resolve);
  const reopen = useReconcileStore((s) => s.reopen);
  const hydrateBoxes = useBoxStore((s) => s.hydrate);
  const [picks, setPicks] = useState<Partial<Record<string, 'field' | 'store'>>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (conflict) {
      const init: Partial<Record<string, 'field' | 'store'>> = {};
      conflict.fields.forEach((f) => {
        init[f.field] = f.resolvedBy === 'prefer-store' ? 'store' : 'field';
      });
      setPicks(init);
    }
  }, [conflict]);

  if (!conflict) return null;

  const submit = async () => {
    setSaving(true);
    try {
      await resolve(
        conflict.id,
        picks as Partial<Record<keyof CoreBox, 'field' | 'store'>>,
      );
      await hydrateBoxes();
      message.success(`箱 ${conflict.boxNo} 已按逐条认领结果入库`);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      width={860}
      title={`两版同留 · 逐条认领 · 箱 ${conflict.boxNo}`}
      onCancel={onClose}
      footer={
        <Space>
          {conflict.status === 'resolved' ? (
            <Button
              onClick={async () => {
                await reopen(conflict.id);
                message.info('已退回待认领');
                onClose();
              }}
            >
              退回待认领
            </Button>
          ) : null}
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" icon={<CheckCircleOutlined />} loading={saving} onClick={submit}>
            确认认领并入库
          </Button>
        </Space>
      }
    >
      <Alert
        style={{ marginBottom: 12 }}
        type="info"
        showIcon
        message="同一个岩芯箱两边都动过。回次/岩性/破损格默认取现场，库架位/借出状态默认取岩芯库；下列共有字段两侧不一致，请逐条认一版。"
      />
      <Table<FieldConflict>
        rowKey="field"
        size="small"
        pagination={false}
        dataSource={conflict.fields}
        columns={[
          { title: '字段', dataIndex: 'label', width: 110, render: (v: string) => <Text strong>{v}</Text> },
          {
            title: <Tag color="blue">现场离线版</Tag>,
            width: 200,
            render: (_, f) => <ValueView value={f.fieldValue} />,
          },
          {
            title: <Tag color="gold">岩芯库台账版</Tag>,
            width: 200,
            render: (_, f) => <ValueView value={f.storeValue} />,
          },
          {
            title: '认哪一版',
            render: (_, f) => (
              <Radio.Group
                value={picks[f.field] ?? 'field'}
                onChange={(e) => setPicks((p) => ({ ...p, [f.field]: e.target.value }))}
                optionType="button"
                size="small"
                options={[
                  { label: '现场', value: 'field' },
                  { label: '台账', value: 'store' },
                ]}
              />
            ),
          },
        ]}
      />
      <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
        上一版基准值：
        {conflict.fields.map((f) => (
          <Tag key={f.field}>
            {f.label}={<ValueView value={f.base} />}
          </Tag>
        ))}
      </Paragraph>
    </Modal>
  );
}

/** 现场离线箱 ↔ 岩芯库台账 合并对账 */
export default function Reconcile() {
  const { message, modal } = AntApp.useApp();
  const { conflicts, baselineCount, appliedCount, lastRun, loading, refresh, applyLedger } = useReconcileStore();
  const boxes = useBoxStore((s) => s.boxes);
  const hydrateBoxes = useBoxStore((s) => s.hydrate);
  const [text, setText] = useState('');
  const [retryMode, setRetryMode] = useState<'prefer-field' | 'prefer-store'>('prefer-field');
  const [active, setActive] = useState<BoxConflict | null>(null);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const pendingConflicts = conflicts.filter((c) => c.status === 'pending');

  const stats = lastRun?.result.stats;

  const handleApply = async () => {
    if (!text.trim()) {
      message.warning('请先粘贴或上传岩芯库台账 JSON');
      return;
    }
    try {
      const outcome = await applyLedger(text, retryMode);
      await hydrateBoxes();
      if (outcome.duplicated) {
        message.info('同一份台账此前已送过，已跳过重放，未新增记录');
        return;
      }
      if (outcome.retried) {
        modal.warning({
          title: '严格对账存在两侧同改，已按侧重试一遍',
          content: `严格模式有 ${outcome.result.stats.conflicts} 箱挂起，已按「${
            retryMode === 'prefer-field' ? '现场侧优先' : '岩芯库侧优先'
          }」自动合并出可入库版本，两版均保留在下方，可逐条复核改判。`,
        });
      } else {
        message.success(`对账完成：合并 ${outcome.result.stats.merged} 箱，待认领 ${outcome.result.stats.conflicts} 箱`);
      }
    } catch (error) {
      // 落库失败已在服务层事务回滚，这里提示上一版仍在
      message.error({
        content: `对账失败，已保住上一版结果，未写入任何改动：${(error as Error).message}`,
        duration: 6,
      });
    }
  };

  const uploadProps: UploadProps = {
    accept: '.json,application/json',
    showUploadList: false,
    beforeUpload: (file) => {
      const reader = new FileReader();
      reader.onload = () => setText(String(reader.result ?? ''));
      reader.readAsText(file);
      message.info(`已读入台账文件：${file.name}`);
      return false;
    },
  };

  const conflictColumns: TableColumnsType<BoxConflict> = [
    {
      title: '状态',
      dataIndex: 'status',
      width: 120,
      render: (_, row) =>
        row.status === 'pending' ? (
          <Badge status="processing" text="待认领" />
        ) : row.manual ? (
          <Badge status="success" text="人工已确认" />
        ) : (
          <Badge status="warning" text="自动消解·可改判" />
        ),
    },
    { title: '箱号', dataIndex: 'boxNo', width: 140, render: (v: string) => <Text strong>{v}</Text> },
    {
      title: '分歧字段（两版同留）',
      render: (_, row) => (
        <Space size={4} wrap>
          {row.fields.map((f) => (
            <Tag key={f.field} color={f.resolvedBy ? 'purple' : 'orange'}>
              {f.label}
              {f.resolvedBy ? ` · ${f.resolvedBy === 'prefer-field' ? '取现场' : '取台账'}` : ''}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '现场版 / 台账版',
      width: 320,
      render: (_, row) => (
        <Space size={8} direction="vertical" style={{ lineHeight: 1.3 }}>
          {row.fields.slice(0, 2).map((f) => (
            <Text key={f.field} type="secondary" style={{ fontSize: 12 }}>
              <Tag color="blue" style={{ marginInlineEnd: 4 }}>现</Tag>
              {String(f.fieldValue ?? '空')}
              {' ｜ '}
              <Tag color="gold" style={{ marginInlineEnd: 4 }}>库</Tag>
              {String(f.storeValue ?? '空')}
            </Text>
          ))}
        </Space>
      ),
    },
    {
      title: '操作',
      width: 140,
      render: (_, row) => (
        <Button size="small" type="link" onClick={() => setActive(row)}>
          {row.status === 'pending' ? '逐条认领' : '查看/改判'}
        </Button>
      ),
    },
  ];

  const sampleTip = useMemo(
    () => `上次合并基准 ${baselineCount} 箱 · 已登记台账 ${appliedCount} 份（同份重送不重复入库）`,
    [baselineCount, appliedCount],
  );

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        现场岩芯箱 × 岩芯库台账 合并对账
      </Title>
      <Paragraph type="secondary">
        箱内回次、岩性、破损格以现场离线编录为准；库架位、借出状态以岩芯库出入库台账为准。同一箱两边都动过则两版都留，逐条认领；合并失败自动保住上一版并按侧重试；同一份台账重复送不会多出记录。
      </Paragraph>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={10}>
          <Card
            size="small"
            title="岩芯库出入库台账"
            extra={
              <Space>
                <Button size="small" onClick={() => boxes.length && setText(buildSampleLedger(boxes))}>
                  填入示例
                </Button>
                <Button
                  size="small"
                  onClick={() => downloadText(`store-ledger-template.json`, JSON.stringify({ app: 'store-ledger', batchId: '', boxes: [] }, null, 2))}
                >
                  下载模板
                </Button>
              </Space>
            }
          >
            <Upload.Dragger {...uploadProps} style={{ padding: 12, marginBottom: 12 }}>
              <p style={{ margin: 0 }}>
                <InboxOutlined style={{ fontSize: 26, color: '#1677ff' }} />
              </p>
              <Text type="secondary" style={{ fontSize: 12 }}>
                点击或拖入台账 JSON（{`{ "boxes": [...] }`} 或数组）
              </Text>
            </Upload.Dragger>

            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder='也可直接粘贴：&#10;{&#10;  "batchId": "RK-20260930-01",&#10;  "boxes": [&#10;    { "boxNo": "X-2402-01", "shelfPos": "B 区 2 架", "loanStatus": "借出", "loanTo": "中心实验室" }&#10;  ]&#10;}'
              style={{
                width: '100%',
                minHeight: 180,
                fontFamily: 'monospace',
                fontSize: 12,
                padding: 8,
                border: '1px solid #d9d9d9',
                borderRadius: 6,
                resize: 'vertical',
              }}
            />

            <Space style={{ marginTop: 12 }} wrap>
              <Text type="secondary">侧重试偏好：</Text>
              <Radio.Group
                value={retryMode}
                onChange={(e) => setRetryMode(e.target.value)}
                optionType="button"
                size="small"
                options={[
                  { label: '现场侧优先', value: 'prefer-field' },
                  { label: '岩芯库侧优先', value: 'prefer-store' },
                ]}
              />
              <Button type="primary" icon={<RetweetOutlined />} loading={loading} onClick={handleApply}>
                合并对账
              </Button>
            </Space>
            <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
              {sampleTip}
            </Paragraph>
          </Card>
        </Col>

        <Col xs={24} lg={14}>
          <Card size="small" title="对账结果">
            {stats ? (
              <Row gutter={16} style={{ marginBottom: 12 }}>
                <Col span={6}>
                  <Statistic title="涉及箱数" value={stats.total} />
                </Col>
                <Col span={6}>
                  <Statistic title="干净合并" value={stats.merged} valueStyle={{ color: '#3f8600' }} />
                </Col>
                <Col span={6}>
                  <Statistic title="待逐条认领" value={stats.conflicts} valueStyle={{ color: stats.conflicts ? '#cf1322' : undefined }} />
                </Col>
                <Col span={6}>
                  <Statistic title="台账新增箱" value={stats.storeOnly} />
                </Col>
              </Row>
            ) : (
              <Empty description="尚未对账" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}

            {lastRun && !lastRun.duplicated && lastRun.result.warnings.length > 0 && (
              <Alert
                style={{ marginBottom: 12 }}
                type="warning"
                showIcon
                message="台账数据提示"
                description={
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {lastRun.result.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                }
              />
            )}

            {lastRun?.retried && (
              <Alert
                style={{ marginBottom: 12 }}
                type="warning"
                showIcon
                message="严格对账有挂起，已按侧重试自动合并（两版仍保留，可在下方改判）"
              />
            )}

            {lastRun && (
              <Descriptions size="small" column={2} bordered>
                <Descriptions.Item label="现场独有（保留未删）">{lastRun.result.fieldOnly.length}</Descriptions.Item>
                <Descriptions.Item label="台账补建">{lastRun.result.storeOnly.length}</Descriptions.Item>
                <Descriptions.Item label="自动侧重消解">{lastRun.result.stats.autoResolved}</Descriptions.Item>
                <Descriptions.Item label="完全一致">{lastRun.result.unchanged.length}</Descriptions.Item>
              </Descriptions>
            )}
          </Card>
        </Col>

        <Col span={24}>
          <Card
            size="small"
            title={
              <Space>
                两版同留 · 待认领分歧
                <Tag color={pendingConflicts.length ? 'red' : 'green'}>{pendingConflicts.length} 待认</Tag>
              </Space>
            }
          >
            <Table
              rowKey="id"
              size="small"
              columns={conflictColumns}
              dataSource={conflicts}
              pagination={{ pageSize: 6 }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有两侧同改的分歧" /> }}
            />
          </Card>
        </Col>
      </Row>

      <ResolveModal conflict={active} onClose={() => setActive(null)} />
    </div>
  );
}
