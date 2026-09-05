import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { fetchJson, getSelfUid, httpsUrl, resolveUid } from './utils.js';

export const PRIVATE_FOLLOWING_MARKER = 'PRIVATE_FOLLOWING';

/** B 站对隐藏关注列表返回 code 22115「用户已设置隐私，无法查看」。 */
export function isPrivateFollowingError(payload) {
    if (!payload || typeof payload !== 'object') return false;
    return payload.code === 22115 || /隐私|privacy/i.test(String(payload.message ?? ''));
}

cli({
    site: 'bilibili',
    name: 'following',
    access: 'read',
    description: '获取 Bilibili 用户的关注列表',
    domain: 'www.bilibili.com',
    strategy: Strategy.COOKIE,
    args: [
        { name: 'uid', positional: true, required: false, help: '目标用户 ID（默认为当前登录用户）' },
        { name: 'page', type: 'int', required: false, default: 1, help: '页码' },
        { name: 'limit', type: 'int', required: false, default: 50, help: '每页数量 (最大 50)' },
    ],
    columns: ['mid', 'name', 'sign', 'following', 'fans', 'avatar'],
    func: async (page, kwargs) => {
        if (!page)
            throw new CommandExecutionError('Browser session required for bilibili following');
        // 1. Resolve UID (default to self)
        const uid = kwargs.uid
            ? await resolveUid(page, kwargs.uid)
            : await getSelfUid(page);
        const pn = kwargs.page ?? 1;
        const ps = Math.min(kwargs.limit ?? 50, 50);
        // 2. Fetch following list (standard Cookie API, no Wbi signing needed)
        const payload = await fetchJson(page, `https://api.bilibili.com/x/relation/followings?vmid=${uid}&pn=${pn}&ps=${ps}&order=desc`);
        if (payload.code !== 0) {
            if (isPrivateFollowingError(payload)) {
                // 对方隐藏了关注列表：exit 0 + 空数组 + stderr 一行 PRIVATE_FOLLOWING，
                // 下游按这个字面判「跳过」，不重试、不计入休眠账。
                process.stderr.write(`${PRIVATE_FOLLOWING_MARKER}\n`);
                return [];
            }
            throw new CommandExecutionError(`获取关注列表失败: ${payload.message} (${payload.code})`);
        }
        const list = payload.data?.list || [];
        // 3. Map to output（空页返回空数组，不再塞占位行）
        return list.map((u) => ({
            mid: u.mid,
            name: u.uname,
            sign: (u.sign || '').slice(0, 40),
            following: u.attribute === 6 ? '互相关注' : '已关注',
            fans: u.official_verify?.desc || '',
            avatar: httpsUrl(u.face) || null,
        }));
    },
});
