import { isIP } from 'node:net';

export function formatBytes(value: number | undefined): string {
  if (value === undefined) return '-';
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let current = value;
  let unit = -1;
  do {
    current /= 1024;
    unit += 1;
  } while (current >= 1024 && unit < units.length - 1);
  return `${current >= 100 ? current.toFixed(0) : current.toFixed(1)} ${units[unit]}`;
}

export function targetHostLabel(host: string): 'IP' | '主机' {
  return isIP(host) === 0 ? '主机' : 'IP';
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) return '-';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [days > 0 ? `${days} 天` : '', hours > 0 ? `${hours} 小时` : '', `${minutes} 分钟`]
    .filter(Boolean)
    .join(' ');
}

export function formatDateTime(value: string, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone,
    timeZoneName: 'shortOffset',
    year: 'numeric',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const offset = values.timeZoneName === 'GMT' ? 'GMT+0' : values.timeZoneName;
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second} ${offset}`;
}

export function displayBoolean(value: boolean | undefined): string {
  if (value === undefined) return '-';
  return value ? '是' : '否';
}

export function displayList(values: readonly string[]): string {
  return values.length === 0 ? '-' : values.join(', ');
}

export function statusLabel(value: string): string {
  const labels: Record<string, string> = {
    completed: '已完成',
    conflict: '冲突',
    confirmed: '已确认',
    critical: '严重',
    failed: '失败',
    high: '高',
    inferred: '推断',
    info: '信息',
    low: '低',
    medium: '中',
    partial: '部分完成',
    running: '运行中',
    stopped: '已停止',
    success: '成功',
    unknown: '未知',
  };
  return labels[value] ?? value;
}
