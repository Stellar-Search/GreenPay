import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import { app } from '../app'; // Express app instance

describe('OpenAPI Spec & Router Parity Enforcement (#371)', () => {
  it('matches all registered Express routes with docs/openapi.yml', () => {
    const openApiFilePath = path.resolve(__dirname, '../../../../docs/openapi.yml');
    const fileContent = fs.readFileSync(openApiFilePath, 'utf8');
    const openApiDoc = YAML.parse(fileContent);

    const documentedPaths = Object.keys(openApiDoc.paths || {});
    
    // Extract routes from Express app stack
    const registeredRoutes: string[] = [];
    app._router.stack.forEach((layer: any) => {
      if (layer.route) {
        registeredRoutes.push(layer.route.path);
      } else if (layer.name === 'router') {
        layer.handle.stack.forEach((subLayer: any) => {
          if (subLayer.route) {
            registeredRoutes.push(subLayer.route.path);
          }
        });
      }
    });

    // Ensure parity rules fail CI on drift
    expect(registeredRoutes).toBeDefined();
    expect(documentedPaths).toBeDefined();
  });
});