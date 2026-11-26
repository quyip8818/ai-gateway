import type { Product } from "../products";

export function setupSnippet(
  protocol: Product["protocol"],
  origin: string,
  operation: string,
  model: string,
) {
  switch (protocol) {
    case "responses":
      return [
        'model_provider = "team-gateway"',
        "model = " + JSON.stringify(model),
        "",
        "[model_providers.team-gateway]",
        'name = "AI Gateway"',
        'base_url = "' + origin + '/openai/v1"',
        'env_key = "GATEWAY_KEY"',
        'wire_api = "responses"',
        "supports_websockets = false",
      ].join("\n");
    case "messages":
      return [
        'export ANTHROPIC_BASE_URL="' + origin + '/anthropic"',
        'export ANTHROPIC_AUTH_TOKEN="$GATEWAY_KEY"',
        "export ANTHROPIC_MODEL=" + JSON.stringify(model),
      ].join("\n");
    case "media": {
      const body = JSON.stringify({
        model,
        operation,
        prompt: "雨后街道倒映霓虹灯，电影感构图",
      }).replaceAll("'", "'\\''");
      return [
        'curl --fail-with-body "' + origin + '/media/v1/jobs"',
        '-H "Authorization: Bearer $GATEWAY_KEY"',
        "-H 'Content-Type: application/json'",
        '-H "Idempotency-Key: ${JOB_KEY:?请设置本次任务的 JOB_KEY}"',
        "--data '" + body + "'",
      ].join(" \\\n  ");
    }
  }
}
