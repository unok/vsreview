import { isExplanationAgent, type ExplanationAgent } from '../core/explanations';
import { vsreviewConfiguration } from './configuration';
export const EXPLANATION_AGENT_DEFAULT: ExplanationAgent = 'claude';
export function explanationAgentSetting(): ExplanationAgent {
  // 起動するコマンドを決める値なので、リポジトリにある設定値は採用しない。
  const value: unknown = vsreviewConfiguration().inspect('explanation.agent')?.globalValue;
  return isExplanationAgent(value) ? value : EXPLANATION_AGENT_DEFAULT;
}
