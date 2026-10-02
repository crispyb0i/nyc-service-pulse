import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import pg from 'pg';
import type { MapResponse, MapBounds } from '../src/lib/map-types';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, options: "-c jit=off" });
const cases: { name: string; bounds: MapBounds; zoom: number; problem?: string }[] = [
  { name: 'defaultDesktop', bounds: [-74.583301, 40.372214, -73.398603, 41.046466], zoom: 9.5 },
  { name: 'city', bounds: [-74.6, 40.3, -73.4, 41.15], zoom: 10.5 },
  { name: 'lowerManhattan', bounds: [-74.025, 40.695, -73.975, 40.735], zoom: 14 },
  { name: 'filteredNeighborhood', bounds: [-74.025, 40.695, -73.975, 40.735], zoom: 14, problem: 'Noise - Residential' },
  { name: 'wideBoundsMaximumZoom', bounds: [-74.6, 40.3, -73.4, 41.15], zoom: 18.5 },
  { name: 'empty', bounds: [-74.025, 40.695, -73.975, 40.735], zoom: 14, problem: '__no_such_problem__' },
];
try {
  const location = await pool.query<{ longitude: number; latitude: number }>(`SELECT longitude,latitude
    FROM service_requests WHERE geom IS NOT NULL GROUP BY longitude,latitude HAVING count(*) BETWEEN 2 AND 10 LIMIT 1`);
  const { longitude: x, latitude: y } = location.rows[0];
  cases.push({ name: 'individualRequests', bounds: [x-0.000002, y-0.000002, x+0.000002, y+0.000002], zoom: 18.5 });
  const measurements = [];
  for (const item of cases) {
    const [west,south,east,north] = item.bounds;
    const query = new URLSearchParams({ from:'2026-08-01', to:'2026-08-31', west:String(west),south:String(south),east:String(east),north:String(north),zoom:String(item.zoom) });
    if (item.problem) query.set('problem',item.problem);
    const url = `http://127.0.0.1:3100/api/map?${query}`;
    const samples = [];
    let final: MapResponse | undefined;
    for (let i=0;i<6;i++) {
      const start = performance.now();
      const response = await fetch(url);
      const text = await response.text();
      if (!response.ok) throw new Error(`${item.name}: ${response.status} ${text}`);
      const data = JSON.parse(text) as MapResponse;
      assert.equal(data.features.reduce((sum,feature)=>sum+feature.count,0),data.visibleRequests);
      assert.ok(data.features.length <= (data.mode==='points'?100:400));
      for (const feature of data.features) {
        assert.ok(feature.longitude>=west && feature.longitude<=east && feature.latitude>=south && feature.latitude<=north);
      }
      samples.push({ ms:Math.round((performance.now()-start)*100)/100, bytes:Buffer.byteLength(text), features:data.features.length, count:data.visibleRequests, mode:data.mode });
      final=data;
    }
    const values: unknown[] = [...item.bounds];
    let problem = '';
    if (item.problem) {values.push(item.problem);problem=' AND problem=$5';}
    const count=await pool.query(`SELECT count(*)::int AS count FROM service_requests
      WHERE created_at>='2026-08-01' AND created_at<'2026-09-01' AND geom IS NOT NULL
      AND ST_Intersects(geom,ST_MakeEnvelope($1,$2,$3,$4,4326))${problem}`,values);
    assert.equal(final!.visibleRequests,count.rows[0].count);
    const sorted = samples.slice(1).map(sample=>sample.ms).sort((a,b)=>a-b);
    measurements.push({ name:item.name,bounds:item.bounds,zoom:item.zoom,problem:item.problem??null,path:`/api/map?${query}`,first:samples[0],warmMedianMs:sorted[2],warmMaxMs:sorted.at(-1),samples });
  }
  const sizes = [];
  for (const path of ['public/map/boroughs.geojson','public/map/labels.geojson','public/map/neighborhood-labels.geojson']) {
    sizes.push({path,bytes:(await stat(path)).size});
  }
  const baseline=JSON.parse(await readFile('reports/milestone-1/measurements.json','utf8'));
  const regression=JSON.parse(await readFile('reports/measurements.json','utf8'));
  const report={measuredAt:new Date().toISOString(),environment:'Local production Next server; same Docker PostgreSQL17/PostGIS3.5 amd64 emulation,1GB/1.5CPUs. One initial+5 sequential warm samples; uncompressed JSON bytes; no concurrent project tests during run. HTTP timing is request-through-body, not FPS.',measurements,geographyAssets:sizes,dashboardComparison:regression.measurements.map((item:{name:string;warmMedianMs:number})=>({name:item.name,baselineWarmMedianMs:baseline.measurements.find((previous:{name:string})=>previous.name===item.name)?.warmMedianMs,currentWarmMedianMs:item.warmMedianMs})),countsVerifiedAgainstIndependentSQL:true};
  await writeFile('reports/map-measurements.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({endpoints:measurements.map(item=>({name:item.name,medianMs:item.warmMedianMs,bytes:item.first.bytes,features:item.first.features,count:item.first.count,mode:item.first.mode})),geographyAssets:sizes,dashboardComparison:report.dashboardComparison},null,2));
} finally {await pool.end();}
