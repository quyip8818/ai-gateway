export { unsupportedJimengImageModelKeys } from '../../providers/jimeng/model-catalog.ts';

export function supportedAccountModel(parameter: number) {
  return `NOT (a.provider='jimeng' AND m.operation='image' AND m.upstream_id=ANY($${parameter}::text[]))`;
}
