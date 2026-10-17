/** Server-only Amap adapter. Never expose upstream URLs, keys or raw errors. */
export function diningError(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}
export function point(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(',');
  if (parts.length !== 2 || parts.some(item => !item.trim())) return null;
  const [longitude, latitude] = parts.map(Number);
  return Number.isFinite(longitude) && Number.isFinite(latitude) && Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90
    ? { longitude, latitude, coordinateSystem: 'gcj02' } : null;
}
export const coordinates = value => `${value.longitude.toFixed(6)},${value.latitude.toFixed(6)}`;
export function distanceMeters(a, b) {
  const rad = value => value * Math.PI / 180;
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2
    + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return Math.round(6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h))));
}
const text = (value, limit = 300) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
function numeric(value, max) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= max ? number : null;
}
export function normalizePoi(raw, origin, fetchedAt) {
  if (!raw || typeof raw !== 'object' || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.id ?? '') || !text(raw.name, 150)) return null;
  const location = point(raw.location);
  if (!location || !/^05\d{4}$/.test(raw.typecode ?? '')) return null;
  const business = raw.business && !Array.isArray(raw.business) ? raw.business : {};
  const entrance = point(raw.navi?.entr_location);
  const photo = Array.isArray(raw.photos) ? raw.photos.find(item => {
    try { const url = new URL(item.url); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
  }) : null;
  return { id: raw.id, name: text(raw.name, 150), address: text(raw.address), type: text(raw.type), typecode: raw.typecode,
    location, navigationLocation: entrance && distanceMeters(entrance, location) <= 300 ? entrance : location,
    straightDistanceMeters: distanceMeters(origin, location), tags: text(business.tag, 500).split(/[;,，；|]/).map(item => item.trim()).filter(Boolean),
    costYuan: numeric(business.cost, 100000), rating: numeric(business.rating, 5),
    openingHoursToday: text(business.opentime_today, 200) || null,
    openingHoursDescription: text(business.opentime_week, 500) || null,
    photoUrl: photo ? text(photo.url, 1500) : null, fetchedAt, source: 'amap' };
}

export class AmapProvider {
  constructor(env = process.env, fetcher = fetch) {
    this.key = (env.AMAP_WEB_SERVICE_KEY ?? '').trim();
    this.fetcher = fetcher;
    this.timeout = Math.max(1000, Math.min(30000, Number(env.AMAP_TIMEOUT_MS) || 8000));
    this.searchKeywordsMax = Math.max(1, Math.min(3, Math.floor(Number(env.AMAP_SEARCH_KEYWORDS_MAX) || 1)));
  }
  get configured() { return this.key.length > 0; }
  async request(path, parameters, signal) {
    if (!this.configured) throw diningError('AMAP_NOT_CONFIGURED', '请先在服务端配置高德 Web 服务 Key', 503);
    const url = new URL(path, 'https://restapi.amap.com');
    Object.entries({ ...parameters, key: this.key }).forEach(([name, value]) => url.searchParams.set(name, String(value)));
    const timeout = AbortSignal.timeout(this.timeout);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetcher(url.toString(), { headers: { Accept: 'application/json' }, redirect: 'error', signal: combined });
      if (!response.ok) throw diningError('AMAP_UNAVAILABLE', '高德服务暂时不可用，请稍后重试', 502);
      const data = await response.json();
      if (String(data?.status) !== '1' || String(data?.infocode) !== '10000')
        throw diningError('AMAP_REQUEST_REJECTED', '高德请求未通过，请检查服务端 Key、权限和调用额度', 502);
      return data;
    } catch (error) {
      if (signal?.aborted) throw diningError('DINING_CANCELLED', '这次推荐已取消');
      if (timeout.aborted) throw diningError('AMAP_TIMEOUT', '高德请求超时，请稍后重试', 504);
      if (['AMAP_UNAVAILABLE', 'AMAP_REQUEST_REJECTED'].includes(error.code)) throw error;
      throw diningError('AMAP_UNAVAILABLE', '高德服务暂时不可用，请稍后重试', 502);
    }
  }
  async locate(location, signal) {
    if (location.coordinateSystem === 'gcj02') return { longitude: location.longitude, latitude: location.latitude, coordinateSystem: 'gcj02' };
    const data = await this.request('/v3/assistant/coordinate/convert', { locations: coordinates(location), coordsys: 'gps', output: 'JSON' }, signal);
    const converted = point(data.locations);
    if (!converted) throw diningError('AMAP_INVALID_LOCATION', '高德返回的位置格式不正确', 502);
    return converted;
  }
  async search(origin, preferences, fetchedAt, signal) {
    const keywords = (preferences.style === 'plant-forward' ? ['蔬食', '素食', '轻食']
      : preferences.style === 'lighter' ? ['轻食', '沙拉', '蒸菜'] : ['轻食', '蒸菜', '清汤']).slice(0, this.searchKeywordsMax);
    const results = await Promise.allSettled(keywords.map(keyword => this.request('/v5/place/around', {
      location: coordinates(origin), types: '050000', keywords: keyword, radius: preferences.radiusMeters,
      sortrule: 'distance', page_size: 25, page_num: 1, show_fields: 'business,photos,navi',
    }, signal)));
    const succeeded = results.filter(result => result.status === 'fulfilled');
    if (!succeeded.length) throw results[0].reason;
    const pois = new Map();
    for (const result of succeeded) {
      if (!Array.isArray(result.value.pois)) throw diningError('AMAP_INVALID_RESPONSE', '高德返回的餐厅格式不正确', 502);
      for (const raw of result.value.pois) {
        const poi = normalizePoi(raw, origin, fetchedAt);
        if (poi && !pois.has(poi.id)) pois.set(poi.id, poi);
      }
    }
    return { candidates: [...pois.values()].slice(0, 60), partial: succeeded.length !== results.length };
  }
  async detail(poi, origin, fetchedAt, signal) {
    const data = await this.request('/v5/place/detail', { id: poi.id, show_fields: 'business,photos,navi' }, signal);
    if (!Array.isArray(data.pois)) throw diningError('AMAP_INVALID_RESPONSE', '高德返回的餐厅详情格式不正确', 502);
    const raw = data.pois.find(item => item.id === poi.id);
    if (!raw) return null;
    // Detail sometimes omits fields available in around-search; retain their original provenance.
    return normalizePoi({ id: poi.id, name: poi.name, address: poi.address, type: poi.type, typecode: poi.typecode,
      location: coordinates(poi.location), ...raw, business: {
        tag: poi.tags.join(';'), cost: poi.costYuan, rating: poi.rating, opentime_today: poi.openingHoursToday,
        opentime_week: poi.openingHoursDescription, ...raw.business,
      }, photos: raw.photos ?? (poi.photoUrl ? [{ url: poi.photoUrl }] : []),
      navi: raw.navi ?? { entr_location: coordinates(poi.navigationLocation) } }, origin, fetchedAt);
  }
  async walking(origin, poi, signal) {
    const data = await this.request('/v5/direction/walking', { origin: coordinates(origin),
      destination: coordinates(poi.navigationLocation), destination_id: poi.id, show_fields: 'cost' }, signal);
    const route = data.route?.paths?.[0];
    const distance = numeric(route?.distance, 200000), duration = numeric(route?.cost?.duration, 172800);
    if (distance === null || duration === null) throw diningError('AMAP_NO_WALKING_ROUTE', '暂时没有可用的步行路线', 502);
    return { status: 'ready', distanceMeters: Math.round(distance), durationSeconds: Math.round(duration), source: 'amap' };
  }
}

export function navigationLinks(origin, poi) {
  function link(callnative) {
    const url = new URL('https://uri.amap.com/navigation');
    url.searchParams.set('from', `${coordinates(origin)},当前位置`);
    url.searchParams.set('to', `${coordinates(poi.navigationLocation)},${poi.name.replaceAll(',', '，')}`);
    url.searchParams.set('mode', 'walk');
    url.searchParams.set('src', 'Habi');
    url.searchParams.set('callnative', String(callnative));
    return url.toString();
  }
  return { provider: 'amap', mode: 'walk', url: link(1), fallbackUrl: link(0), destination: poi.navigationLocation };
}
