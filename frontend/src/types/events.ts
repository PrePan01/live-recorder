import type { Room } from './room';
import type { Recording } from './recording';
import type { Alert } from './alert';
import type { Settings } from './settings';
import type { DiskSpace, ServiceStatus } from './service';
import type { Diagnostic } from './diagnostic';
import type { UploadJob } from '../api/openlist';

export type ServerEvent =
  | { type: 'room:updated'; room: Room }
  | { type: 'recording:updated'; recording: Recording }
  | { type: 'alert:created'; alert: Alert }
  | { type: 'alert:updated'; alert: Alert }
  | { type: 'settings:updated'; settings: Settings }
  | { type: 'service:status'; serviceStatus: ServiceStatus }
  | { type: 'disk:space'; disk: DiskSpace }
  | { type: 'diagnostic:updated'; diagnostic: Diagnostic }
  | { type: 'upload:updated'; upload: UploadJob };

export const SSE_EVENT_NAMES = [
  'room:updated',
  'recording:updated',
  'alert:created',
  'alert:updated',
  'settings:updated',
  'service:status',
  'disk:space',
  'diagnostic:updated',
  'upload:updated',
] as const satisfies ServerEvent['type'][];
