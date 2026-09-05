import { cli, Strategy } from '@jackwener/opencli/registry';
import { apiGet, httpsUrl, parseDurationText, payloadData, resolveUid } from './utils.js';
cli({
    site: 'bilibili',
    name: 'user-videos',
    access: 'read',
    description: '查看指定用户的投稿视频',
    domain: 'www.bilibili.com',
    strategy: Strategy.COOKIE,
    args: [
        { name: 'uid', required: true, positional: true, help: 'User UID or username' },
        { name: 'limit', type: 'int', default: 20, help: 'Number of results' },
        { name: 'order', default: 'pubdate', help: 'Sort: pubdate, click, stow' },
        { name: 'page', type: 'int', default: 1, help: 'Page number' },
    ],
    columns: ['rank', 'title', 'plays', 'likes', 'comments', 'danmaku', 'date', 'created_ts', 'duration', 'duration_sec', 'url', 'bvid', 'cover', 'desc', 'is_pay'],
    func: async (page, kwargs) => {
        const { uid: uidInput, limit = 20, order = 'pubdate', page: pageNum = 1 } = kwargs;
        const uid = await resolveUid(page, String(uidInput));
        const payload = await apiGet(page, '/x/space/wbi/arc/search', {
            params: {
                mid: uid,
                pn: pageNum,
                ps: Math.min(Number(limit), 50),
                order,
            },
            signed: true,
        });
        const vlist = payloadData(payload)?.list?.vlist ?? [];
        return vlist.slice(0, Number(limit)).map((item, i) => ({
            rank: i + 1,
            title: item.title ?? '',
            plays: item.play ?? 0,
            likes: item.like ?? 0,
            comments: item.comment ?? 0,
            // vlist 里弹幕数的字段名是 video_review，不是 danmaku。
            danmaku: item.video_review ?? 0,
            // date 只到天（保留不动），created_ts 是接口原始的 unix 秒。
            date: item.created ? new Date(item.created * 1000).toISOString().slice(0, 10) : '',
            created_ts: item.created ?? 0,
            duration: item.length ?? '',
            duration_sec: parseDurationText(item.length),
            url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : '',
            bvid: item.bvid ?? '',
            cover: httpsUrl(item.pic),
            desc: item.description ?? '',
            // 付费 / 合作稿件：ml-scout 用它替掉精选阶段单独打 video 接口拿 paid_content。
            is_pay: !!item.is_pay,
        }));
    },
});
