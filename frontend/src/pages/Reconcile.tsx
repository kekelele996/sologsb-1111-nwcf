import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Descriptions,
  Popconfirm,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  CloudUploadOutlined,
  CloudDownloadOutlined,
  MergeCellsOutlined,
  UndoOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useMergeStore } from '../stores/mergeStore';
import { useBoxStore } from '../stores/boxStore';
import { useHoleStore } from '../stores/holeStore';
import type { BoxMergeResult, MergedBox } from '../types/warehouse';
import { conflictRows, FIELD_OWNED_LABEL, WAREHOUSE_OWNED_LABEL } from '../utils/merge';
import EmptyPanel from '../components/common/EmptyPanel';

const { Title, Paragraph, Text } = Typography;

/** 台账对账：现场离线岩芯箱 与 岩芯库出入库台账 合并对账 */
export default function Reconcile() {
  const { message, modal } = AntApp.useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');

  const boxes = useBoxStore((s) => s.boxes);
  const holes = useHoleStore((s) => s.holes);
  const {
    report,
    ledger,
    appliedLedgerIds,
    snapshotExists,
    applying,
    failedSide,
    lastError,
    lastApplied,
    loadMeta,
    importLedgerText,
    clearLedger,
    applyMerge,
    retrySide,
    restoreSnapshot,
    resolveConflict,
    exportLedger,
  } = useMergeStore();

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  const holeNoByHoleId = useMemo(() => {
    const m = new Map<string, string>();
    holes.forEach((h) => m.set(h.id, h.holeNo));
    return m;
  }, [holes]);

  const holeNoOf = (box: MergedBox | undefined): string =>
    box?.holeId ? holeNoByHoleId.get(box.holeId) ?? '—' : '未匹配';

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        importLedgerText(String(reader.result ?? ''));
        setFileName(file.name);
        message.success(`已解析台账 ${file.name}`);
      } catch (error) {
        message.error(`台账解析失败：${(error as Error).message}`);
      }
    };
    reader.onerror = () => message.error('台账文件读取失败');
    reader.readAsText(file);
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) readFile(file);
    e.target.value = '';
  };

  const handleApply = async () => {
    modal.confirm({
      title: '确认按现场 / 库管两侧落库合并结果？',
      content: '落库前会先保存当前箱表快照；现场侧与库管侧分别写入，失败可按侧重试或恢复上一版。',
      okText: '确认合并',
      cancelText: '取消',
      onOk: async () => {
        await applyMerge();
      },
    });
  };

  const handleRestore = async () => {
    await restoreSnapshot();
    message.success('已恢复合并前上一版结果');
  };

  const conflicts = report?.results.filter((r) => r.kind === 'conflict') ?? [];
  const autoMerged = report?.results.filter((r) => r.kind === 'auto-merged') ?? [];
  const fieldOnly = report?.results.filter((r) => r.kind === 'field-only') ?? [];
  const warehouseOnly = report?.results.filter((r) => r.kind === 'warehouse-only') ?? [];
  const unchanged = report?.results.filter((r) => r.kind === 'unchanged') ?? [];

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        岩芯箱台账对账
      </Title>
      <Paragraph type="secondary">
        现场编录员离线的岩芯箱与岩芯库出入库台账合并对账：{FIELD_OWNED_LABEL}，{WAREHOUSE_OWNED_LABEL}
        ；同一个箱两边都动过同一字段时两版都留着逐条认。合并失败先保住上一版结果，按现场侧 / 库管侧重试；同一份台账再送一次不多出记录。
      </Paragraph>

      <Alert
        style={{ marginBottom: 12 }}
        type="info"
        showIcon
        message="对账口径"
        description={
          <Space size={16} wrap>
            <Text>
              现场算：<Text strong>回次、岩性、破损格、结构</Text>
            </Text>
            <Text>
              库管算：<Text strong>库架位、借出状态</Text>
            </Text>
            <Text type="secondary">两边都动过同一字段 → 两版都留着逐条认</Text>
          </Space>
        }
      />

      <Space style={{ marginBottom: 12 }} wrap>
        <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={onPickFile} />
        <Button type="primary" icon={<CloudUploadOutlined />} onClick={() => fileRef.current?.click()}>
          导入岩芯库台账（JSON）
        </Button>
        <Button icon={<CloudDownloadOutlined />} onClick={exportLedger}>
          导出现场台账（送岩芯库）
        </Button>
        {report ? (
          <>
            <Button
              type="primary"
              ghost
              icon={<MergeCellsOutlined />}
              loading={applying}
              onClick={handleApply}
              disabled={lastApplied && conflicts.length === 0}
            >
              执行合并落库
            </Button>
            <Button icon={<UndoOutlined />} onClick={clearLedger}>
              清空本次导入
            </Button>
          </>
        ) : null}
        {snapshotExists ? (
          <Popconfirm title="恢复合并前快照？当前箱表将被上一版结果覆盖。" onConfirm={handleRestore}>
            <Button icon={<UndoOutlined />}>恢复上一版</Button>
          </Popconfirm>
        ) : null}
      </Space>

      {lastError ? (
        <Alert
          style={{ marginBottom: 12 }}
          type="error"
          showIcon
          message={lastError}
          action={
            failedSide ? (
              <Button size="small" type="primary" onClick={() => retrySide(failedSide)} loading={applying}>
                <ReloadOutlined /> 重试{failedSide === 'field' ? '现场侧' : '库管侧'}
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {!report ? (
        <EmptyPanel
          description="尚未导入岩芯库台账。可导入岩芯库提供的 JSON 台账，或先「导出现场台账」生成一份再稍作改动后导入，体验合并对账。"
          actionText="导入岩芯库台账"
          onAction={() => fileRef.current?.click()}
        />
      ) : (
        <>
          {lastApplied ? (
            <Alert
              style={{ marginBottom: 12 }}
              type="success"
              showIcon
              message="合并结果已落库"
              description={
                conflicts.length
                  ? `仍有 ${conflicts.length} 个冲突箱两版待逐条认，可在下方逐条保留现场版或库管版。`
                  : '本次对账结果已全部落库，无未决冲突。'
              }
            />
          ) : null}

          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            <Col xs={12} sm={8} md={4}>
              <Card size="small">
                <Statistic title="自动合并" value={report.autoMerged} valueStyle={{ color: '#3f8600' }} />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Card size="small">
                <Statistic title="两版待认" value={report.conflicts} valueStyle={{ color: '#cf1322' }} />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Card size="small">
                <Statistic title="仅现场" value={report.fieldOnly} />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Card size="small">
                <Statistic title="仅库管" value={report.warehouseOnly} />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Card size="small">
                <Statistic title="重复未变" value={report.unchanged} valueStyle={{ color: '#8a99a5' }} />
              </Card>
            </Col>
            <Col xs={24} md={4}>
              <Card size="small">
                <Statistic title="台账批次" value={report.ledgerId} valueStyle={{ fontSize: 14 }} />
              </Card>
            </Col>
          </Row>

          {conflicts.length ? (
            <Card
              size="small"
              title={
                <Space>
                  <Tag color="red">两版待认</Tag>
                  <Text>同一个箱两边都动过同一字段，两版都留着，请逐条认</Text>
                </Space>
              }
              style={{ marginBottom: 12 }}
            >
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {conflicts.map((r) => (
                  <ConflictCard
                    key={r.boxNo}
                    result={r}
                    holeNoOf={holeNoOf}
                    onResolve={(keep) => resolveConflict(r.boxNo, keep)}
                  />
                ))}
              </Space>
            </Card>
          ) : null}

          {autoMerged.length ? (
            <Card size="small" title={<Tag color="green">自动合并（现场编录 + 库管架位/借出）</Tag>} style={{ marginBottom: 12 }}>
              <Table
                rowKey="boxNo"
                size="small"
                pagination={false}
                dataSource={autoMerged}
                columns={[
                  { title: '箱号', dataIndex: 'boxNo', width: 130, render: (v: string) => <Text strong>{v}</Text> },
                  { title: '孔号', width: 110, render: (_, r) => holeNoOf(r.merged) },
                  { title: '深度区间(m)', width: 130, render: (_, r) => `${r.merged?.fromDepth}~${r.merged?.toDepth}` },
                  { title: '库架位', dataIndex: ['merged', 'shelfPos'], width: 120 },
                  {
                    title: '借出状态',
                    dataIndex: ['merged', 'loanStatus'],
                    width: 100,
                    render: (v: string) => <Tag color={v === '借出' ? 'orange' : 'blue'}>{v ?? '在库'}</Tag>,
                  },
                  { title: '说明', dataIndex: 'message' },
                ]}
              />
            </Card>
          ) : null}

          <Row gutter={[12, 12]}>
            {fieldOnly.length ? (
              <Col xs={24} lg={12}>
                <Card size="small" title={<Tag>仅现场（库管未涉及）</Tag>} style={{ marginBottom: 12 }}>
                  <Table
                    rowKey="boxNo"
                    size="small"
                    pagination={false}
                    dataSource={fieldOnly}
                    columns={[
                      { title: '箱号', dataIndex: 'boxNo', width: 130, render: (v: string) => <Text strong>{v}</Text> },
                      { title: '孔号', width: 110, render: (_, r) => holeNoOf(r.merged) },
                      {
                        title: '破损格',
                        width: 90,
                        render: (_, r) =>
                          r.merged?.damagedSlots?.length ? <Tag color="red">{r.merged.damagedSlots.join(',')}</Tag> : <Tag color="green">无</Tag>,
                      },
                      { title: '说明', dataIndex: 'message' },
                    ]}
                  />
                </Card>
              </Col>
            ) : null}
            {warehouseOnly.length ? (
              <Col xs={24} lg={12}>
                <Card size="small" title={<Tag color="geekblue">仅库管（按库管口径新增）</Tag>} style={{ marginBottom: 12 }}>
                  <Table
                    rowKey="boxNo"
                    size="small"
                    pagination={false}
                    dataSource={warehouseOnly}
                    columns={[
                      { title: '箱号', dataIndex: 'boxNo', width: 130, render: (v: string) => <Text strong>{v}</Text> },
                      { title: '孔号', width: 110, render: (_, r) => holeNoOf(r.merged) },
                      { title: '库架位', dataIndex: ['merged', 'shelfPos'], width: 120 },
                      {
                        title: '借出状态',
                        dataIndex: ['merged', 'loanStatus'],
                        width: 100,
                        render: (v: string) => <Tag color={v === '借出' ? 'orange' : 'blue'}>{v ?? '在库'}</Tag>,
                      },
                      { title: '说明', dataIndex: 'message' },
                    ]}
                  />
                </Card>
              </Col>
            ) : null}
          </Row>

          {unchanged.length ? (
            <Card size="small" title={<Tag color="default">重复送达（无变化，未多出记录）</Tag>} style={{ marginBottom: 12 }}>
              <Table
                rowKey="boxNo"
                size="small"
                pagination={false}
                dataSource={unchanged}
                columns={[
                  { title: '箱号', dataIndex: 'boxNo', width: 130, render: (v: string) => <Text strong>{v}</Text> },
                  { title: '说明', dataIndex: 'message' },
                ]}
              />
            </Card>
          ) : null}
        </>
      )}

      {appliedLedgerIds.length ? (
        <Card size="small" title="已应用台账批次" style={{ marginTop: 12 }}>
          <Space wrap>
            {appliedLedgerIds.map((id) => (
              <Tag key={id} color="blue">
                {id}
              </Tag>
            ))}
          </Space>
        </Card>
      ) : null}
    </div>
  );
}

/** 冲突箱两版对比卡片 */
function ConflictCard({
  result,
  holeNoOf,
  onResolve,
}: {
  result: BoxMergeResult;
  holeNoOf: (box: MergedBox | undefined) => string;
  onResolve: (keep: 'field' | 'warehouse') => void;
}) {
  const { modal } = AntApp.useApp();
  const field = result.fieldBox;
  const wh = result.warehouseBox;
  if (!field || !wh) return null;

  const rows = conflictRows(field, wh);

  const keep = (side: 'field' | 'warehouse') => {
    modal.confirm({
      title: `保留${side === 'field' ? '现场版' : '库管版'} ${result.boxNo}？`,
      content: `另一版将被移除，该箱按${side === 'field' ? '现场编录' : '库管台账'}口径落库。`,
      okText: '确认保留',
      cancelText: '取消',
      onOk: () => onResolve(side),
    });
  };

  return (
    <Card
      size="small"
      type="inner"
      title={
        <Space>
          <Text strong>{result.boxNo}</Text>
          <Tag color="red">两版待认</Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {result.message}
          </Text>
        </Space>
      }
    >
      <Row gutter={[12, 12]}>
        <Col xs={24} md={12}>
          <Card size="small" title={<Tag color="green">现场版（编录口径）</Tag>} style={{ height: '100%' }}>
            <Descriptions size="small" column={1} colon>
              <Descriptions.Item label="孔号">{holeNoOf(field)}</Descriptions.Item>
              <Descriptions.Item label="深度区间">
                {field.fromDepth}~{field.toDepth}m
              </Descriptions.Item>
              <Descriptions.Item label="格数 / 每格">
                {field.slots} 格 × {field.slotLength}m
              </Descriptions.Item>
              <Descriptions.Item label="库架位">{field.shelfPos || '—'}</Descriptions.Item>
              <Descriptions.Item label="借出状态">
                <Tag color={field.loanStatus === '借出' ? 'orange' : 'blue'}>{field.loanStatus ?? '在库'}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="破损格">
                {field.damagedSlots?.length ? <Tag color="red">{field.damagedSlots.join(',')}</Tag> : <Tag color="green">无</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label="装箱人">{field.operator || '—'}</Descriptions.Item>
            </Descriptions>
            <Button type="primary" block style={{ marginTop: 8 }} onClick={() => keep('field')}>
              保留现场版
            </Button>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small" title={<Tag color="geekblue">库管版（出入库口径）</Tag>} style={{ height: '100%' }}>
            <Descriptions size="small" column={1} colon>
              <Descriptions.Item label="孔号">{holeNoOf(wh)}</Descriptions.Item>
              <Descriptions.Item label="深度区间">
                {wh.fromDepth}~{wh.toDepth}m
              </Descriptions.Item>
              <Descriptions.Item label="格数 / 每格">
                {wh.slots} 格 × {wh.slotLength}m
              </Descriptions.Item>
              <Descriptions.Item label="库架位">
                <Text strong>{wh.shelfPos || '—'}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="借出状态">
                <Tag color={wh.loanStatus === '借出' ? 'orange' : 'blue'}>
                  <Text strong>{wh.loanStatus ?? '在库'}</Text>
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="破损格">
                {wh.damagedSlots?.length ? <Tag color="red">{wh.damagedSlots.join(',')}</Tag> : <Tag color="green">无</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label="装箱人">{wh.operator || '—'}</Descriptions.Item>
            </Descriptions>
            <Button block style={{ marginTop: 8 }} onClick={() => keep('warehouse')}>
              保留库管版
            </Button>
          </Card>
        </Col>
      </Row>
      {rows.length ? (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          message={
            <Space wrap size={4}>
              <Text type="secondary">两版取值不同的字段：</Text>
              {rows.map((r) => (
                <Tag key={r.field} color="orange">
                  {r.label}：现场「{r.fieldValue}」/ 库管「{r.warehouseValue}」
                </Tag>
              ))}
            </Space>
          }
        />
      ) : null}
    </Card>
  );
}
