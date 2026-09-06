/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within, waitFor } from 'storybook/test';
import type {
  WorkHubController,
  WorkHubCoordinationTurn,
  WorkHubProjection,
} from '../src/renderer/workhub-controller';
import { WorkHubSurface } from '../src/renderer/workhub-surface';

// Fidelity convention (#1433): every story names the real app path that
// reaches it. See apps/desktop/stories/FIDELITY.md.
//
// Real host: app-shell.tsx mounts <WorkHubSurface> in the conversation column
// when WorkHub is enabled and a Coordination Session exists. The surface takes
// its `controller` as a prop — the same seam production fills with
// `createWorkHubController` — so a story serves one pinned projection and
// conversation instead of driving a live Coordination Session.

const TARGET_SESSION_ID = 'session-workhub-target';
const SESSION_NAME = '支付回调幂等性';
const PROJECT_NAME = 'maka-agent';
const LOCALE = 'zh-CN';

const meta = {
  title: 'Product/WorkHub',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function submittedTurn(): WorkHubCoordinationTurn {
  return {
    messageId: 'message-1',
    turnId: 'turn-1',
    text: `继续${SESSION_NAME}，补充重复投递测试点。`,
    state: 'running',
    assignment: {
      actionId: 'action-1',
      delegationId: 'delegation-1',
      targetSessionId: TARGET_SESSION_ID,
      targetSessionName: SESSION_NAME,
      targetMessageId: 'target-message-1',
      targetTurnId: 'target-turn-1',
      feedbackState: 'running',
      linkState: 'active',
    },
    updatedAt: 1,
  };
}

function projection(): WorkHubProjection {
  return {
    sessions: [
      {
        target: { sessionId: TARGET_SESSION_ID },
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        archived: false,
        state: 'running',
        updatedAt: 1,
      },
    ],
    turns: [],
  };
}

function controller(turns: readonly WorkHubCoordinationTurn[]): WorkHubController {
  return {
    read: async () => projection(),
    submit: async () => {
      throw new Error('submission is not part of these stories');
    },
    openConversation: async (handler) => {
      handler(turns);
      return { close: async () => {} };
    },
    recordConversationTurn: async ({ turnId }) => ({ turnId }),
    subscribe: () => () => {},
    resetVisitContext: () => {},
  };
}

function Surface(props: { turns: readonly WorkHubCoordinationTurn[] }) {
  return (
    <div className="maka-detail-with-artifacts" style={{ height: '100dvh' }}>
      <div className="mainColumn">
        <WorkHubSurface
          controller={controller(props.turns)}
          leaseScope="session-workhub-coordination"
          locale={LOCALE}
          onOpenSession={() => {}}
        />
      </div>
    </div>
  );
}

// Real path: WorkHub routed a prompt to an existing Session and reports where
// the work went. The target's project name is a `<small>` inside the Button's
// own label column, so it has to stay inside the control's box: a project name
// that overflows the button reads as loose text under an unrelated row.
export const SubmittedWorkKeepsTargetMetadataInside: Story = {
  render: () => <Surface turns={[submittedTurn()]} />,
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(canvasElement.querySelector('.workhub-submitted-session small')).not.toBeNull();
    });
    const button = canvasElement.querySelector<HTMLElement>('.workhub-submitted > button');
    const project = canvasElement.querySelector<HTMLElement>('.workhub-submitted-session small');
    if (!button || !project) throw new Error('submitted work control is missing');

    expect(project.textContent).toBe(PROJECT_NAME);
    expect(button.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(
      project.getBoundingClientRect().bottom,
    );
  },
};

// Real path: the production WorkHubSurface derives the Rail from Session facts.
// Filtering and responsive geometry need a renderer, not an Electron/Host fixture.
const anchorRailPlay: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const rail = await canvas.findByRole('complementary', { name: '工作导航' });
  const navigation = within(rail);
  await expect(await navigation.findByRole('button', { name: new RegExp(SESSION_NAME) })).toBeVisible();
  await userEvent.click(navigation.getByRole('button', { name: '待处理' }));
  await expect(navigation.getByText('此筛选下没有工作')).toBeVisible();
  await expect(navigation.queryByRole('button', { name: new RegExp(SESSION_NAME) })).toBeNull();
  await userEvent.click(navigation.getByRole('button', { name: '全部' }));
  await expect(await navigation.findByRole('button', { name: new RegExp(SESSION_NAME) })).toBeVisible();
  const conversation = canvasElement.querySelector<HTMLElement>('.workhub-conversation-shell');
  const composer = canvasElement.querySelector<HTMLElement>('.workhub-surface .maka-composer-editor');
  if (!conversation || !composer) throw new Error('WorkHub conversation or composer missing');
  const railBox = rail.getBoundingClientRect();
  const conversationBox = conversation.getBoundingClientRect();
  const composerBox = composer.getBoundingClientRect();
  if (window.innerWidth <= 1240) {
    expect(railBox.bottom).toBeLessThanOrEqual(conversationBox.top + 1);
  } else {
    expect(railBox.right).toBeLessThanOrEqual(conversationBox.left);
    expect(Math.abs(composerBox.left + composerBox.width / 2 -
      (conversationBox.left + conversationBox.width / 2))).toBeLessThanOrEqual(4);
  }
};

export const AnchorRailFiltersAndReflows: Story = {
  render: () => <Surface turns={[submittedTurn()]} />,
  play: anchorRailPlay,
};

// The render smoke runner selects its narrow viewport from this story ID.
export const AnchorRailFiltersAndReflowsNarrow: Story = {
  ...AnchorRailFiltersAndReflows,
};
