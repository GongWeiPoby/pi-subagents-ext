import { anthropicMessagesApi } from '@earendil-works/pi-ai/compat';
import spawnAnthropicAttribution, {
  type PiExtensionHost,
} from '../core/anthropic-attribution';

// Always-on safety entrypoint for package-owned isolated Anthropic children.
// Ambient parent capability selection must never disable this extension.
export default function childAnthropicAttribution(pi: PiExtensionHost): void {
  spawnAnthropicAttribution(pi, { hostAnthropicMessagesApi: anthropicMessagesApi });
}
