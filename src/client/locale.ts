export const ZH = {
  'cost.title': '会话花费', 'cost.loading': '加载中…', 'cost.unavailable': '不可用', 'cost.partial': '部分统计',
  'tier.peak': '高峰时段', 'tier.offPeak': '空闲时段', 'tier.peakShort': '峰', 'tier.offPeakShort': '谷',
  'tier.nextPeak': '距高峰开始', 'tier.nextOffPeak': '距空闲开始',
  'detail.total': '合计', 'detail.own': '本会话', 'detail.others': '其他会话', 'detail.period': '计费时段',
  'detail.peak': '高峰花费', 'detail.offPeak': '空闲花费', 'detail.calls': '已计费调用',
  'detail.team': '团队成员',
  'detail.sessions': '会话数', 'detail.coverage': '覆盖状态', 'detail.failed': '失败 / 省略会话',
  'detail.rates': '当前费率', 'detail.rateUnit': '元 / 百万 tokens（命中 / 未命中 / 输出）',
  'detail.complete': '完整',
  'action.refresh': '刷新', 'action.refreshing': '正在刷新…', 'action.refreshHint': '重新读取此范围的最新统计，不重放会话日志',
  'issue.unknown-model': '未知模型，部分调用未计费', 'issue.invalid-usage': '用量报告无效',
  'issue.missing-usage': '缺少用量报告', 'issue.holiday-data-missing': '节假日数据缺失',
  'issue.before-rate-card': '调用早于当前价目表', 'issue.routing-disputed': '模型路由存在争议',
  'issue.session-unavailable': '会话不可用', 'issue.scope-unavailable': '统计范围不可用', 'issue.scope-truncated': '统计范围已截断',
} as const
export type LocaleKey = keyof typeof ZH
export type Translate = (key: LocaleKey, params?: Record<string, unknown>) => string
export const EN: Record<LocaleKey, string> = {
  'cost.title': 'Session cost', 'cost.loading': 'Loading…', 'cost.unavailable': 'Unavailable', 'cost.partial': 'Partial',
  'tier.peak': 'Peak', 'tier.offPeak': 'Off-peak', 'tier.peakShort': 'Peak', 'tier.offPeakShort': 'Off',
  'tier.nextPeak': 'Peak starts in', 'tier.nextOffPeak': 'Off-peak starts in',
  'detail.total': 'Total', 'detail.own': 'This session', 'detail.others': 'Other sessions', 'detail.period': 'Billing period',
  'detail.peak': 'Peak cost', 'detail.offPeak': 'Off-peak cost', 'detail.calls': 'Priced calls',
  'detail.team': 'Team roster',
  'detail.sessions': 'Sessions', 'detail.coverage': 'Coverage', 'detail.failed': 'Failed / omitted sessions',
  'detail.rates': 'Current rates', 'detail.rateUnit': 'CNY / 1M tokens (hit / miss / output)',
  'detail.complete': 'Complete',
  'action.refresh': 'Refresh', 'action.refreshing': 'Refreshing…', 'action.refreshHint': 'Read the latest totals for this scope without replaying session logs',
  'issue.unknown-model': 'Unknown model; some calls are unpriced', 'issue.invalid-usage': 'Invalid usage report',
  'issue.missing-usage': 'Missing usage report', 'issue.holiday-data-missing': 'Holiday data missing',
  'issue.before-rate-card': 'Call predates current rate card', 'issue.routing-disputed': 'Disputed model routing',
  'issue.session-unavailable': 'Session unavailable', 'issue.scope-unavailable': 'Scope unavailable', 'issue.scope-truncated': 'Scope truncated',
}
export const fallbackTranslate: Translate = (key, params) => ZH[key].replace(/\{(\w+)\}/g, (match: string, name: string) => params && name in params ? String(params[name]) : match)
