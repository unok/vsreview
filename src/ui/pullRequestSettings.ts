import { vsreviewConfiguration } from './configuration';
import { PULL_REQUEST_REMOTE } from '../core/pullRequests';
import { isPositiveInteger } from '../core/validation';
export const PULL_REQUEST_DEFAULT_LIMIT = 50;
export const PULL_REQUEST_MAX_LIMIT = 1000;
export function pullRequestLimitSetting(repo: string): number {
  const value: unknown = vsreviewConfiguration(repo).get('pullRequests.limit');
  return isPositiveInteger(value) && value <= PULL_REQUEST_MAX_LIMIT ? value : PULL_REQUEST_DEFAULT_LIMIT;
}
export function pullRequestRemoteSetting(): string {
  const value: unknown = vsreviewConfiguration().inspect('pullRequests.remote')?.globalValue;
  return typeof value === 'string' && value.trim() ? value.trim() : PULL_REQUEST_REMOTE;
}
