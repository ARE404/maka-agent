import type { Meta, StoryObj } from '@storybook/react-vite';
import { Composer } from '@maka/ui';

const meta = {
  title: 'Product/Composer/Next Prompt Suggestion',
  component: Composer,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div
        className="maka-panel maka-panel-detail"
        style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="maka-detail-with-artifacts">
          <div className="mainColumn" style={{ justifyContent: 'flex-end' }}>
            <Story />
          </div>
        </div>
      </div>
    ),
  ],
  args: {
    onSend: () => true,
    onStop: () => {},
    modelLabel: 'gpt-5.2-codex',
  },
} satisfies Meta<typeof Composer>;

export default meta;

type Story = StoryObj<typeof meta>;

// Real path: an ordinary agent turn settles, the empty Composer receives a
// model-generated next user message, and Tab promotes it to an editable draft.
export const Suggestion: Story = {
  args: {
    promptSuggestion: '运行测试并修复失败项',
  },
};
