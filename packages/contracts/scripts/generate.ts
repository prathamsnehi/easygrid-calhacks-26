import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { entities } from '../src/schemas.ts';
import { operations, ErrorEnvelope } from '../src/api.ts';
import { apiExamples, happyPath, edgeCases, validateFixtures } from '../src/fixtures.ts';
validateFixtures();
const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: 'draft-2020-12' });
const paths: Record<string, unknown> = {};
for (const [name, op] of Object.entries(operations)) {
  const bodyShape = Object.fromEntries(Object.entries(op.request.shape).filter(([key]) => !op.pathKeys.includes(key)));
  const bodySchema = z.strictObject(bodyShape);
  const example = apiExamples.find(e => e.operation === name)!;
  const requestExample = { ...example.request as Record<string, unknown> };
  for (const key of op.pathKeys) delete requestExample[key];
  const spec = {
    operationId: name, summary: name, tags: ['API v1 contract'],
    parameters: op.pathKeys.map(name => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
    ...(op.method === 'POST' ? { requestBody: { required: true, content: { 'application/json': {
      schema: schema(bodySchema), example: requestExample,
    } } } } : {}),
    responses: { '200': { description: 'Contract success (implementation owned by the corresponding workstream)',
      content: { 'application/json': { schema: schema(op.response), example: example.response } } },
      ...Object.fromEntries([400,401,403,404,409,422,502,503].map(code => [code, { description: `API error ${code}`,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } }])) },
  };
  paths[op.path] = { ...(paths[op.path] as object | undefined), [op.method.toLowerCase()]: spec };
}
const openapi = {
  openapi: '3.1.0', info: { title: 'EasyGrid shared API', version: '1.0.0',
    description: 'CAL-6 contract. No deployed backend is claimed. Runtime refinements and authoritative-state guards remain required; see README.' },
  servers: [{ url: 'http://localhost:3000', description: 'Local adapter placeholder; not a deployed service' }],
  security: [{ sessionAuth: [] }], paths,
  components: { securitySchemes: { sessionAuth: { type: 'http', scheme: 'bearer', description: 'Server-verified session; never a Claude/provider key' } },
    schemas: Object.fromEntries([...Object.entries(entities).map(([name, value]) => [name, schema(value)]), ['ErrorEnvelope', schema(ErrorEnvelope)]]) },
};
const outputs = { 'openapi.json': openapi, 'examples/api-v1.json': apiExamples,
  'examples/happy-path.json': happyPath, 'examples/edge-cases.json': edgeCases };
await mkdir(new URL('../examples/', import.meta.url), { recursive: true });
for (const [name, value] of Object.entries(outputs)) {
  const url = new URL(`../${name}`, import.meta.url), text = JSON.stringify(value, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(url, 'utf8') !== text) throw new Error(`Generated artifact drift: ${name}; run npm run generate`);
  } else await writeFile(url, text);
}
console.log(`${process.argv.includes('--check') ? 'Verified' : 'Generated'} ${Object.keys(outputs).length} artifacts; ${apiExamples.length} API operations.`);
