// Small bundled specs: used by the "Sample" menu and by the unit tests.
export const PETSTORE_30 = {
  openapi: '3.0.3',
  info: { title: 'Petstore', version: '1.0.0', description: 'A **sample** API for pets.\n\n- list pets\n- create pets\n\nSee [docs](https://example.com/docs).', license: { name: 'MIT' } },
  servers: [{ url: 'https://{env}.petstore.example/v1', description: 'Main', variables: { env: { default: 'api', enum: ['api', 'staging'] } } }],
  tags: [{ name: 'pets', description: 'Everything about pets' }, { name: 'store' }],
  security: [{ ApiKey: [] }],
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets', tags: ['pets'], summary: 'List pets', description: 'Returns all pets. Supports `limit`.',
        parameters: [
          { name: 'limit', in: 'query', description: 'Max items', schema: { type: 'integer', format: 'int32', minimum: 1, maximum: 100, default: 20 } },
          { $ref: '#/components/parameters/Status' },
        ],
        responses: {
          200: { description: 'A list of pets', headers: { 'X-Next': { description: 'Next page', schema: { type: 'string' } } }, content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } } },
          default: { $ref: '#/components/responses/Error' },
        },
      },
      post: {
        operationId: 'createPet', tags: ['pets'], summary: 'Create a pet',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewPet' }, example: { name: 'Rex', tag: 'dog' } } } },
        responses: { 201: { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }, 400: { $ref: '#/components/responses/Error' } },
        security: [{ OAuth: ['write:pets'] }],
      },
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: { operationId: 'getPet', tags: ['pets'], summary: 'Get a pet', responses: { 200: { description: 'The pet', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }, 404: { description: 'Not found' } } },
      delete: { operationId: 'deletePet', tags: ['pets'], deprecated: true, summary: 'Delete a pet', security: [], responses: { 204: { description: 'Deleted' } } },
    },
    '/store/inventory': { get: { tags: ['store'], summary: 'Inventory', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', additionalProperties: { type: 'integer', format: 'int32' } } } } } } } },
  },
  components: {
    securitySchemes: {
      ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      OAuth: { type: 'oauth2', flows: { authorizationCode: { authorizationUrl: 'https://auth.example/authorize', tokenUrl: 'https://auth.example/token', scopes: { 'write:pets': 'Modify pets', 'read:pets': 'Read pets' } } } },
    },
    parameters: { Status: { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['available', 'sold'] } } },
    responses: { Error: { description: 'Unexpected error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
    schemas: {
      NewPet: { type: 'object', required: ['name'], properties: { name: { type: 'string', example: 'Rex' }, tag: { type: 'string' } } },
      Pet: { allOf: [{ $ref: '#/components/schemas/NewPet' }, { type: 'object', required: ['id'], properties: { id: { type: 'integer', format: 'int64' }, born: { type: 'string', format: 'date' }, owner: { $ref: '#/components/schemas/Owner' }, kind: { oneOf: [{ $ref: '#/components/schemas/Dog' }, { $ref: '#/components/schemas/Cat' }], discriminator: { propertyName: 'type' } } } }] },
      Dog: { type: 'object', properties: { type: { type: 'string', enum: ['dog'] }, bark: { type: 'boolean', default: true } } },
      Cat: { type: 'object', properties: { type: { type: 'string', enum: ['cat'] }, lives: { type: 'integer', default: 9 } } },
      Owner: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string', format: 'email' }, pets: { type: 'array', items: { $ref: '#/components/schemas/Pet' } }, friend: { $ref: '#/components/schemas/Owner' } } },
      Error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'integer' }, message: { type: 'string' } } },
      Unused: { type: 'string' },
    },
  },
};

export const API_31 = {
  openapi: '3.1.0',
  info: { title: 'Events API', version: '2.0.0', summary: 'Webhook driven' },
  webhooks: {
    newEvent: { post: { operationId: 'onNewEvent', summary: 'Event delivered', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } } }, responses: { 200: { description: 'Return 200 to acknowledge' } } } },
  },
  paths: {
    '/events/{id}': {
      get: { operationId: 'getEvent', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } } } } },
    },
  },
  components: {
    schemas: {
      Event: { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, note: { type: ['string', 'null'], description: 'Optional note' }, at: { type: 'string', format: 'date-time' }, tags: { type: 'array', items: { type: 'string' }, examples: [['a', 'b']] }, kind: { const: 'event' }, parent: { $ref: '#/components/schemas/Event' } } },
    },
  },
};

export const SWAGGER_20 = {
  swagger: '2.0',
  info: { title: 'Legacy API', version: '0.1' },
  host: 'api.example.com', basePath: '/v2', schemes: ['https'],
  consumes: ['application/json'], produces: ['application/json'],
  securityDefinitions: { basic: { type: 'basic' }, key: { type: 'apiKey', in: 'query', name: 'api_key' } },
  paths: {
    '/users': {
      get: { operationId: 'listUsers', tags: ['users'], summary: 'Users', parameters: [{ name: 'page', in: 'query', type: 'integer', default: 1 }], responses: { 200: { description: 'ok', schema: { type: 'array', items: { $ref: '#/definitions/User' } } } } },
      post: { operationId: 'createUser', tags: ['users'], parameters: [{ name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/User' } }], responses: { 201: { description: 'created', schema: { $ref: '#/definitions/User' }, examples: { 'application/json': { id: 1, name: 'Ann' } } } } },
    },
    '/users/{id}/avatar': {
      post: { operationId: 'uploadAvatar', consumes: ['multipart/form-data'], parameters: [{ name: 'id', in: 'path', required: true, type: 'integer' }, { name: 'file', in: 'formData', type: 'file', required: true }], responses: { 200: { description: 'ok' } } },
    },
  },
  definitions: {
    User: { type: 'object', required: ['name'], properties: { id: { type: 'integer', format: 'int64' }, name: { type: 'string' }, manager: { $ref: '#/definitions/User' } } },
  },
};
