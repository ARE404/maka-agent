import type { WorkRetriever, WorkspaceHostDirectory } from './decision-types.js';

export function createWorkRetriever(hostDirectory: WorkspaceHostDirectory): WorkRetriever {
  return {
    async recall(_intent, context) {
      const hostList = await hostDirectory.list();
      const workspaces = await Promise.all(hostList.map((host) => host.summary()));
      const hosts = new Map(
        hostList.map((host, index) => [workspaces[index]!.id, host] as const),
      );
      const skipCandidateRecall = [
        'explicit_work',
        'explicit_workspace',
        'bound_reply',
      ].includes(_intent.kind);
      const candidates = skipCandidateRecall ? [] : (
        await Promise.all(
          hostList.map((host, index) => {
            const workspace = workspaces[index];
            if (!workspace?.available || workspace.incognitoActive) return [];
            return host.listWorkCandidates(context.input.text, 8).catch(() => []);
          }),
        )
      ).flat();
      return { workspaces, candidates, hosts };
    },
  };
}
