import { loadBootstrapOptions, ModelBootstrapRunner } from './model-bootstrap';

const runner = new ModelBootstrapRunner(loadBootstrapOptions());
runner.start();
