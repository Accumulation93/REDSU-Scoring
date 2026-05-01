const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const PAGE_SIZE = 100;
function safeString(value) { return String(value == null ? '' : value).trim(); }
async function getAllRecords(query) { const list=[]; let skip=0; while(true){ const res=await query.where({}).skip(skip).limit(PAGE_SIZE).get(); const batch=res.data||[]; list.push(...batch); if(batch.length<PAGE_SIZE) break; skip+=batch.length; } return list; }
async function ensureAdmin(openid) { const res=await db.collection('admin_info').where({ openid, bindStatus:'active' }).limit(1).get(); return res.data[0]||null; }
exports.main = async () => { try { const wxContext=cloud.getWXContext(); const admin=await ensureAdmin(wxContext.OPENID); if(!admin) return { status:'forbidden', message:'无管理权限' }; const rows=await getAllRecords(db.collection('departments')).catch(()=>[]); const departments=rows.map((item)=>({ id:safeString(item._id), key:safeString(item._id), name:safeString(item.name), description:safeString(item.description), createdAt:item.createdAt, updatedAt:item.updatedAt })).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')); return { status:'success', departments }; } catch(error){ return { status:'error', message:safeString(error && (error.message || error.errMsg)) || '加载部门列表失败' }; } };
