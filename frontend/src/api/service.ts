import { http } from './client';
import type { ServiceStatus } from '../types/service';

export async function fetchServiceStatus(): Promise<ServiceStatus> {
  const { data } = await http.get<{ serviceStatus: ServiceStatus }>('/service/status');
  return data.serviceStatus;
}
