import type { IntentClassifier, IntentResult } from './decision-types.js';

const EXECUTABLE_PATTERNS = [
  /(?:修复|修掉|实现|创建|新增|删除|更新|修改|改一下|改掉|运行|执行|测试|检查|排查|重构|写|补完|继续|处理|分析一下|看一下|看看)/u,
  /\b(?:fix|implement|create|add|delete|remove|update|change|run|test|check|debug|refactor|write|continue)\b/iu,
];

const INTERACTION_REPLY = /^(?:可以|同意|允许|继续|是|否|好的|确认|ok|okay|yes|no|allow|continue)[。.!！]?$/iu;

export function createIntentClassifier(): IntentClassifier {
  return {
    classify({ input }): IntentResult {
      if (input.explicitWork) {
        return { kind: 'explicit_work', evidence: ['explicit Work binding'] };
      }
      if (input.explicitWorkspaceId) {
        return { kind: 'explicit_workspace', evidence: ['explicit Workspace binding'] };
      }
      if (input.replyToBlockId) {
        return { kind: 'bound_reply', evidence: ['reply-to-block binding'] };
      }
      const text = input.text.trim();
      if (INTERACTION_REPLY.test(text)) {
        return { kind: 'interaction_reply', evidence: ['interaction reply shape'] };
      }
      if (looksExecutable(text)) {
        return { kind: 'executable', evidence: ['executable language'] };
      }
      return { kind: 'discussion_candidate', evidence: ['no deterministic execution signal'] };
    },
  };
}

export function looksExecutable(text: string): boolean {
  return EXECUTABLE_PATTERNS.some((pattern) => pattern.test(text));
}
