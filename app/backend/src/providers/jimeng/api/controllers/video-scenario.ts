import { randomUUID } from 'node:crypto';

import EX from '@/api/consts/exceptions.ts';
import APIException from '@/lib/exceptions/APIException.ts';
import { request } from './core.ts';

const draftVersion = '3.3.40';
const minDraftVersion = '3.3.35';
const features = ['AIGC_Scenario'];
const assistantId = 513695;
const generateType = 'scenario_tool_gen_video';

interface ScenarioVideoInput {
    scene: string;
    generateType: number;
    materials: Array<Record<string, unknown>>;
    bindings: Array<{ slot_id: string; role: string; material_idxs: number[] }>;
    prompt: string;
    params: Record<string, unknown>;
}

export function createScenarioVideoDraft(input: ScenarioVideoInput): string {
    const componentId = randomUUID();
    return JSON.stringify({
        type: 'draft',
        id: randomUUID(),
        min_version: minDraftVersion,
        min_features: features,
        is_from_tsn: true,
        version: draftVersion,
        main_component_id: componentId,
        component_list: [{
            type: 'video_base_component',
            id: componentId,
            min_version: '1.0.0',
            aigc_mode: 'workbench',
            gen_type: input.generateType,
            metadata: {
                type: '', id: randomUUID(), created_platform: 3, created_platform_version: '',
                created_time_in_ms: String(Date.now()), created_did: '',
            },
            generate_type: generateType,
            abilities: {
                type: '',
                id: randomUUID(),
                scenario: {
                    type: '',
                    id: randomUUID(),
                    min_version: minDraftVersion,
                    min_features: features,
                    scene: input.scene,
                    material_list: input.materials,
                    material_bindings: input.bindings,
                    text_inputs: [{
                        type: '', id: randomUUID(), key: 'prompt', enabled: true,
                        meta_list: [{ type: '', id: randomUUID(), meta_type: 'text', text: input.prompt }],
                    }],
                    params: input.params,
                },
            },
        }],
    });
}

export function readScenarioVideoDraft(content: unknown) {
    if (typeof content !== 'string') return undefined;
    try {
        const draft = JSON.parse(content);
        const component = Array.isArray(draft?.component_list)
            ? draft.component_list.find(item => item?.id === draft.main_component_id)
            : undefined;
        if (component?.generate_type === generateType) return component.abilities?.scenario;
    } catch {
        return undefined;
    }
}

interface ScenarioVideoSubmission {
    model: string;
    workspaceId: number;
    commerce: Record<string, unknown>;
    draft: string;
    metrics: Record<string, unknown>;
    hasInputVideo: boolean;
}

export async function submitScenarioVideo(token: string, id: string, submission: ScenarioVideoSubmission): Promise<string> {
    const result = await request('post', '/mweb/v1/aigc_draft/generate', token, {
        params: {
            region: 'cn',
            web_version: '7.5.0',
            da_version: draftVersion,
            aigc_features: 'app_lip_sync',
            web_component_open_flag: 1,
            generate_id: randomUUID(),
            commerce_with_input_video: submission.hasInputVideo ? '1' : undefined,
        },
        data: {
            action: 1,
            extend: {
                workspace_id: submission.workspaceId,
                m_video_commerce_info: submission.commerce,
                m_video_commerce_info_list: [submission.commerce],
            },
            submit_id: id,
            metrics_extra: JSON.stringify(submission.metrics),
            draft_content: submission.draft,
            http_common_info: { aid: assistantId },
        },
    }, { retry: false, logPayload: false, model: submission.model });
    if (!result?.aigc_data?.history_record_id) {
        throw new APIException(EX.API_VIDEO_GENERATION_FAILED, '上游未返回场景视频历史记录 ID');
    }
    return String(result.aigc_data.history_record_id);
}
