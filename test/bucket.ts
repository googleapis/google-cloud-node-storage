/**
 * Copyright 2014 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

import * as arrify from 'arrify';
import * as assert from 'assert';
import * as async from 'async';
import {ServiceObject, util, ServiceObjectConfig, DecorateRequestOptions, Metadata} from '@google-cloud/common';
import * as extend from 'extend';
import * as mime from 'mime-types';
import * as path from 'path';
import * as proxyquire from 'proxyquire';
const snakeize = require('snakeize');
import * as stream from 'stream';
import * as through from 'through2';
import {Bucket, Channel, Notification} from '../src';
import {CreateWriteStreamOptions, File, SetFileMetadataOptions} from '../src/file';
import {PromisifyAllOptions} from '@google-cloud/promisify';
import * as r from 'request';
import {GetFilesOptions, MakeAllFilesPublicPrivateOptions} from '../src/bucket';
import {AddAclOptions} from '../src/acl';
import {Func} from 'mocha';

class FakeFile {
  calledWith_: IArguments;
  bucket: Bucket;
  name: string;
  options?: {};
  metadata: {};
  createWriteStream: Function;
  isSameFile?: () => boolean;
  constructor(bucket: Bucket, name: string, options?: {}) {
    this.calledWith_ = arguments;
    this.bucket = bucket;
    this.name = name;
    this.options = options;
    this.metadata = {};

    this.createWriteStream = (options: CreateWriteStreamOptions) => {
      this.metadata = options.metadata;
      const ws = new stream.Writable();
      ws.write = () => {
        ws.emit('complete');
        ws.end();
        return true;
      };
      return ws;
    };
  }
}

class FakeNotification {
  bucket: Bucket;
  id: string;
  constructor(bucket: Bucket, id: string) {
    this.bucket = bucket;
    this.id = id;
  }
}

let eachLimitOverride: Function|null;

const fakeAsync = extend({}, async);
fakeAsync.eachLimit = (...args) =>
    (eachLimitOverride || async.eachLimit).apply(null, args);

let promisified = false;
const fakePromisify = {
  // tslint:disable-next-line:variable-name
  promisifyAll(Class: Function, options: PromisifyAllOptions) {
    if (Class.name !== 'Bucket') {
      return;
    }

    promisified = true;
    assert.deepStrictEqual(options.exclude, [
      'request',
      'file',
      'notification',
    ]);
  },
};

const fakeUtil = extend({}, util);

let extended = false;
const fakePaginator = {
  paginator: {
    // tslint:disable-next-line:variable-name
    extend(Class: Function, methods: string[]) {
      if (Class.name !== 'Bucket') {
        return;
      }

      methods = arrify(methods);
      assert.strictEqual(Class.name, 'Bucket');
      assert.deepStrictEqual(methods, ['getFiles']);
      extended = true;
    },
    streamify(methodName: string) {
      return methodName;
    },
  },
};

class FakeAcl {
  calledWith_: IArguments;
  constructor() {
    this.calledWith_ = [].slice.call(arguments);
  }
}

class FakeIam {
  calledWith_: IArguments;
  constructor() {
    this.calledWith_ = arguments;
  }
}

class FakeServiceObject extends ServiceObject {
  calledWith_: IArguments;
  constructor(config: ServiceObjectConfig) {
    super(config);
    this.calledWith_ = arguments;
  }
}

describe('Bucket', () => {
  // tslint:disable-next-line:variable-name no-any
  let Bucket: any;
  // tslint:disable-next-line: no-any
  let bucket: any;

  const STORAGE = {
    createBucket: util.noop,
  };
  const BUCKET_NAME = 'test-bucket';

  before(() => {
    Bucket = proxyquire('../src/bucket.js', {
               async: fakeAsync,
               '@google-cloud/promisify': fakePromisify,
               '@google-cloud/paginator': fakePaginator,
               '@google-cloud/common': {
                 ServiceObject: FakeServiceObject,
                 util: fakeUtil,
               },
               './acl.js': {Acl: FakeAcl},
               './file.js': {File: FakeFile},
               './iam.js': {Iam: FakeIam},
               './notification.js': {Notification: FakeNotification},
             }).Bucket;
  });

  beforeEach(() => {
    eachLimitOverride = null;
    bucket = new Bucket(STORAGE, BUCKET_NAME);
  });

  describe('instantiation', () => {
    it('should extend the correct methods', () => {
      assert(extended);  // See `fakePaginator.extend`
    });

    it('should streamify the correct methods', () => {
      assert.strictEqual(bucket.getFilesStream, 'getFiles');
    });

    it('should promisify all the things', () => {
      assert(promisified);
    });

    it('should remove a leading gs://', () => {
      const bucket = new Bucket(STORAGE, 'gs://bucket-name');
      assert.strictEqual(bucket.name, 'bucket-name');
    });

    it('should remove a trailing /', () => {
      const bucket = new Bucket(STORAGE, 'bucket-name/');
      assert.strictEqual(bucket.name, 'bucket-name');
    });

    it('should localize the name', () => {
      assert.strictEqual(bucket.name, BUCKET_NAME);
    });

    it('should localize the storage instance', () => {
      assert.strictEqual(bucket.storage, STORAGE);
    });

    describe('ACL objects', () => {
      let _request: typeof r;

      before(() => {
        _request = Bucket.prototype.request;
      });

      beforeEach(() => {
        Bucket.prototype.request = {
          bind(ctx: {}) {
            return ctx;
          },
        };

        bucket = new Bucket(STORAGE, BUCKET_NAME);
      });

      after(() => {
        Bucket.prototype.request = _request;
      });

      it('should create an ACL object', () => {
        assert.deepStrictEqual(bucket.acl.calledWith_[0], {
          request: bucket,
          pathPrefix: '/acl',
        });
      });

      it('should create a default ACL object', () => {
        assert.deepStrictEqual(bucket.acl.default.calledWith_[0], {
          request: bucket,
          pathPrefix: '/defaultObjectAcl',
        });
      });
    });

    it('should inherit from ServiceObject', done => {
      const storageInstance = extend({}, STORAGE, {
        createBucket: {
          bind(context: {}) {
            assert.strictEqual(context, storageInstance);
            done();
          },
        },
      });

      const bucket = new Bucket(storageInstance, BUCKET_NAME);
      assert(bucket instanceof ServiceObject);

      const calledWith = bucket.calledWith_[0];

      assert.strictEqual(calledWith.parent, storageInstance);
      assert.strictEqual(calledWith.baseUrl, '/b');
      assert.strictEqual(calledWith.id, BUCKET_NAME);
      assert.deepStrictEqual(calledWith.methods, {
        create: true,
      });
    });

    it('should localize an Iam instance', () => {
      assert(bucket.iam instanceof FakeIam);
      assert.deepStrictEqual(bucket.iam.calledWith_[0], bucket);
    });

    it('should localize userProject if provided', () => {
      const fakeUserProject = 'grape-spaceship-123';
      const bucket = new Bucket(STORAGE, BUCKET_NAME, {
        userProject: fakeUserProject,
      });

      assert.strictEqual(bucket.userProject, fakeUserProject);
    });
  });

  describe('combine', () => {
    it('should throw if invalid sources are not provided', () => {
      assert.throws(() => {
        bucket.combine();
      }, /You must provide at least two source files\./);

      assert.throws(() => {
        bucket.combine(['1']);
      }, /You must provide at least two source files\./);
    });

    it('should throw if a destination is not provided', () => {
      assert.throws(() => {
        bucket.combine(['1', '2']);
      }, /A destination file must be specified\./);
    });

    it('should accept string or file input for sources', done => {
      const file1 = bucket.file('1.txt');
      const file2 = '2.txt';
      const destinationFileName = 'destination.txt';

      const originalFileMethod = bucket.file;
      bucket.file = (name: string) => {
        const file = originalFileMethod(name);

        if (name === '2.txt') {
          return file;
        }

        assert.strictEqual(name, destinationFileName);

        file.request = (reqOpts: DecorateRequestOptions) => {
          assert.strictEqual(reqOpts.method, 'POST');
          assert.strictEqual(reqOpts.uri, '/compose');
          assert.strictEqual(reqOpts.json.sourceObjects[0].name, file1.name);
          assert.strictEqual(reqOpts.json.sourceObjects[1].name, file2);

          done();
        };

        return file;
      };

      bucket.combine([file1, file2], destinationFileName);
    });

    it('should use content type from the destination metadata', done => {
      const destination = bucket.file('destination.txt');

      destination.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(
            reqOpts.json.destination.contentType,
            mime.contentType(destination.name));

        done();
      };

      bucket.combine(['1', '2'], destination);
    });

    it('should use content type from the destination metadata', done => {
      const destination = bucket.file('destination.txt');
      destination.metadata = {contentType: 'content-type'};

      destination.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(
            reqOpts.json.destination.contentType,
            destination.metadata.contentType);

        done();
      };

      bucket.combine(['1', '2'], destination);
    });

    it('should detect dest content type if not in metadata', done => {
      const destination = bucket.file('destination.txt');

      destination.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(
            reqOpts.json.destination.contentType,
            mime.contentType(destination.name));

        done();
      };

      bucket.combine(['1', '2'], destination);
    });

    it('should make correct API request', done => {
      const sources = [bucket.file('1.txt'), bucket.file('2.txt')];
      const destination = bucket.file('destination.txt');

      destination.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(reqOpts.uri, '/compose');
        assert.deepStrictEqual(reqOpts.json, {
          destination: {contentType: mime.contentType(destination.name)},
          sourceObjects: [{name: sources[0].name}, {name: sources[1].name}],
        });

        done();
      };

      bucket.combine(sources, destination);
    });

    it('should encode the destination file name', done => {
      const sources = [bucket.file('1.txt'), bucket.file('2.txt')];
      const destination = bucket.file('needs encoding.jpg');

      destination.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(reqOpts.uri.indexOf(destination), -1);
        done();
      };

      bucket.combine(sources, destination);
    });

    it('should send a source generation value if available', done => {
      const sources = [bucket.file('1.txt'), bucket.file('2.txt')];
      sources[0].metadata = {generation: 1};
      sources[1].metadata = {generation: 2};

      const destination = bucket.file('destination.txt');

      destination.request = (reqOpts: DecorateRequestOptions) => {
        assert.deepStrictEqual(reqOpts.json.sourceObjects, [
          {name: sources[0].name, generation: sources[0].metadata.generation},
          {name: sources[1].name, generation: sources[1].metadata.generation},
        ]);

        done();
      };

      bucket.combine(sources, destination);
    });

    it('should accept userProject option', done => {
      const options = {
        userProject: 'user-project-id',
      };

      const sources = [bucket.file('1.txt'), bucket.file('2.txt')];
      const destination = bucket.file('destination.txt');

      destination.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(reqOpts.qs, options);
        done();
      };

      bucket.combine(sources, destination, options, assert.ifError);
    });

    it('should execute the callback', done => {
      const sources = [bucket.file('1.txt'), bucket.file('2.txt')];
      const destination = bucket.file('destination.txt');

      destination.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback();
          };

      bucket.combine(sources, destination, done);
    });

    it('should execute the callback with an error', done => {
      const sources = [bucket.file('1.txt'), bucket.file('2.txt')];
      const destination = bucket.file('destination.txt');

      const error = new Error('Error.');

      destination.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(error);
          };

      bucket.combine(sources, destination, (err: Error) => {
        assert.strictEqual(err, error);
        done();
      });
    });

    it('should execute the callback with apiResponse', done => {
      const sources = [bucket.file('1.txt'), bucket.file('2.txt')];
      const destination = bucket.file('destination.txt');
      const resp = {success: true};

      destination.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(null, resp);
          };

      bucket.combine(
          sources, destination, (err: Error, obj: {}, apiResponse: {}) => {
            assert.strictEqual(resp, apiResponse);
            done();
          });
    });
  });

  describe('createChannel', () => {
    const ID = 'id';
    const CONFIG = {
      address: 'https://...',
    };

    it('should throw if an ID is not provided', () => {
      assert.throws(() => {
        bucket.createChannel();
      }, /An ID is required to create a channel\./);
    });

    it('should throw if an address is not provided', () => {
      assert.throws(() => {
        bucket.createChannel(ID, {});
      }, /An address is required to create a channel\./);
    });

    it('should make the correct request', done => {
      const config = extend({}, CONFIG, {
        a: 'b',
        c: 'd',
      });
      const originalConfig = extend({}, config);

      bucket.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(reqOpts.method, 'POST');
        assert.strictEqual(reqOpts.uri, '/o/watch');

        const expectedJson = extend({}, config, {
          id: ID,
          type: 'web_hook',
        });
        assert.deepStrictEqual(reqOpts.json, expectedJson);
        assert.deepStrictEqual(config, originalConfig);

        done();
      };

      bucket.createChannel(ID, config, assert.ifError);
    });

    it('should accept userProject option', done => {
      const options = {
        userProject: 'user-project-id',
      };

      bucket.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(reqOpts.qs, options);
        done();
      };

      bucket.createChannel(ID, CONFIG, options, assert.ifError);
    });

    describe('error', () => {
      const error = new Error('Error.');
      const apiResponse = {};

      beforeEach(() => {
        bucket.request =
            (reqOpts: DecorateRequestOptions, callback: Function) => {
              callback(error, apiResponse);
            };
      });

      it('should execute callback with error & API response', done => {
        bucket.createChannel(
            ID, CONFIG, (err: Error, channel: Channel, apiResponse_: {}) => {
              assert.strictEqual(err, error);
              assert.strictEqual(channel, null);
              assert.strictEqual(apiResponse_, apiResponse);

              done();
            });
      });
    });

    describe('success', () => {
      const apiResponse = {
        resourceId: 'resource-id',
      };

      beforeEach(() => {
        bucket.request =
            (reqOpts: DecorateRequestOptions, callback: Function) => {
              callback(null, apiResponse);
            };
      });

      it('should exec a callback with Channel & API response', done => {
        const channel = {};

        bucket.storage.channel = (id: string, resourceId: string) => {
          assert.strictEqual(id, ID);
          assert.strictEqual(resourceId, apiResponse.resourceId);
          return channel;
        };

        bucket.createChannel(
            ID, CONFIG, (err: Error, channel_: Channel, apiResponse_: {}) => {
              assert.ifError(err);
              assert.strictEqual(channel_, channel);
              assert.strictEqual(channel_.metadata, apiResponse);
              assert.strictEqual(apiResponse_, apiResponse);
              done();
            });
      });
    });
  });

  describe('createNotification', () => {
    const PUBSUB_SERVICE_PATH = '//pubsub.googleapis.com/';
    const TOPIC = 'my-topic';
    const FULL_TOPIC_NAME =
        PUBSUB_SERVICE_PATH + 'projects/{{projectId}}/topics/' + TOPIC;

    class FakeTopic {
      name: string;
      constructor(name: string) {
        this.name = 'projects/grape-spaceship-123/topics/' + name;
      }
    }

    beforeEach(() => {
      fakeUtil.isCustomType = util.isCustomType;
    });

    it('should throw an error if a valid topic is not provided', () => {
      assert.throws(() => {
        bucket.createNotification();
      }, /A valid topic name is required\./);
    });

    it('should make the correct request', done => {
      const topic = 'projects/my-project/topics/my-topic';
      const options = {payloadFormat: 'NONE'};
      const expectedTopic = PUBSUB_SERVICE_PATH + topic;
      const expectedJson = extend({topic: expectedTopic}, snakeize(options));

      bucket.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(reqOpts.method, 'POST');
        assert.strictEqual(reqOpts.uri, '/notificationConfigs');
        assert.deepStrictEqual(reqOpts.json, expectedJson);
        assert.notStrictEqual(reqOpts.json, options);
        done();
      };

      bucket.createNotification(topic, options, assert.ifError);
    });

    it('should accept incomplete topic names', done => {
      bucket.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(reqOpts.json.topic, FULL_TOPIC_NAME);
        done();
      };

      bucket.createNotification(TOPIC, {}, assert.ifError);
    });

    it('should accept a topic object', done => {
      const fakeTopic = new FakeTopic('my-topic');
      const expectedTopicName = PUBSUB_SERVICE_PATH + fakeTopic.name;

      fakeUtil.isCustomType = (topic, type) => {
        assert.strictEqual(topic, fakeTopic);
        assert.strictEqual(type, 'pubsub/topic');
        return true;
      };

      bucket.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(reqOpts.json.topic, expectedTopicName);
        done();
      };

      bucket.createNotification(fakeTopic, {}, assert.ifError);
    });

    it('should set a default payload format', done => {
      bucket.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(reqOpts.json.payload_format, 'JSON_API_V1');
        done();
      };

      bucket.createNotification(TOPIC, {}, assert.ifError);
    });

    it('should optionally accept options', done => {
      const expectedJson = {
        topic: FULL_TOPIC_NAME,
        payload_format: 'JSON_API_V1',
      };

      bucket.request = (reqOpts: DecorateRequestOptions) => {
        assert.deepStrictEqual(reqOpts.json, expectedJson);
        done();
      };

      bucket.createNotification(TOPIC, assert.ifError);
    });

    it('should accept a userProject', done => {
      const options = {
        userProject: 'grape-spaceship-123',
      };

      bucket.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(reqOpts.qs.userProject, options.userProject);
        done();
      };

      bucket.createNotification(TOPIC, options, assert.ifError);
    });

    it('should return errors to the callback', done => {
      const error = new Error('err');
      const response = {};

      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(error, response);
          };

      bucket.createNotification(
          TOPIC, (err: Error, notification: Notification, resp: {}) => {
            assert.strictEqual(err, error);
            assert.strictEqual(notification, null);
            assert.strictEqual(resp, response);
            done();
          });
    });

    it('should return a notification object', done => {
      const fakeId = '123';
      const response = {id: fakeId};
      const fakeNotification = {};

      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(null, response);
          };

      bucket.notification = (id: string) => {
        assert.strictEqual(id, fakeId);
        return fakeNotification;
      };

      bucket.createNotification(
          TOPIC, (err: Error, notification: Notification, resp: {}) => {
            assert.ifError(err);
            assert.strictEqual(notification, fakeNotification);
            assert.strictEqual(notification.metadata, response);
            assert.strictEqual(resp, response);
            done();
          });
    });
  });

  describe('delete', () => {
    it('should make the correct request', done => {
      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            assert.strictEqual(reqOpts.method, 'DELETE');
            assert.strictEqual(reqOpts.uri, '');
            assert.deepStrictEqual(reqOpts.qs, {});
            callback();  // done()
          };

      bucket.delete(done);
    });

    it('should accept options', done => {
      const options = {};

      bucket.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(reqOpts.qs, options);
        done();
      };

      bucket.delete(options, assert.ifError);
    });

    it('should not require a callback', done => {
      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            assert.doesNotThrow(callback);
            done();
          };

      bucket.delete();
    });
  });

  describe('deleteFiles', () => {
    it('should accept only a callback', done => {
      bucket.getFiles = (query: {}, callback: Function) => {
        assert.deepStrictEqual(query, {});
        callback(null, []);
      };

      bucket.deleteFiles(done);
    });

    it('should get files from the bucket', done => {
      const query = {a: 'b', c: 'd'};

      bucket.getFiles = (query_: {}) => {
        assert.deepStrictEqual(query_, query);
        done();
      };

      bucket.deleteFiles(query, assert.ifError);
    });

    it('should process 10 files at a time', done => {
      eachLimitOverride = (arr: {}, limit: number) => {
        assert.strictEqual(limit, 10);
        done();
      };

      bucket.getFiles = (query: {}, callback: Function) => {
        callback(null, []);
      };

      bucket.deleteFiles({}, assert.ifError);
    });

    it('should delete the files', done => {
      const query = {};
      let timesCalled = 0;

      const files = [bucket.file('1'), bucket.file('2')].map(file => {
        file.delete = (query_: {}, callback: Function) => {
          timesCalled++;
          assert.strictEqual(query_, query);
          callback();
        };
        return file;
      });

      bucket.getFiles = (query_: {}, callback: Function) => {
        assert.strictEqual(query_, query);
        callback(null, files);
      };

      bucket.deleteFiles(query, (err: Error) => {
        assert.ifError(err);
        assert.strictEqual(timesCalled, files.length);
        done();
      });
    });

    it('should execute callback with error from getting files', done => {
      const error = new Error('Error.');

      bucket.getFiles = (query: {}, callback: Function) => {
        callback(error);
      };

      bucket.deleteFiles({}, (err: Error) => {
        assert.strictEqual(err, error);
        done();
      });
    });

    it('should execute callback with error from deleting file', done => {
      const error = new Error('Error.');

      const files = [bucket.file('1'), bucket.file('2')].map(file => {
        file.delete = (query: {}, callback: Function) => callback(error);
        return file;
      });

      bucket.getFiles = (query: {}, callback: Function) => {
        callback(null, files);
      };

      bucket.deleteFiles({}, (err: Error) => {
        assert.strictEqual(err, error);
        done();
      });
    });

    it('should execute callback with queued errors', done => {
      const error = new Error('Error.');

      const files = [bucket.file('1'), bucket.file('2')].map(file => {
        file.delete = (query: {}, callback: Function) => {
          callback(error);
        };
        return file;
      });

      bucket.getFiles = (query: {}, callback: Function) => {
        callback(null, files);
      };

      bucket.deleteFiles({force: true}, (errs: Array<{}>) => {
        assert.strictEqual(errs[0], error);
        assert.strictEqual(errs[1], error);
        done();
      });
    });
  });

  describe('deleteLabels', () => {
    describe('all labels', () => {
      it('should get all of the label names', done => {
        bucket.getLabels = () => {
          done();
        };

        bucket.deleteLabels(assert.ifError);
      });

      it('should return an error from getLabels()', done => {
        const error = new Error('Error.');

        bucket.getLabels = (callback: Function) => {
          callback(error);
        };

        bucket.deleteLabels((err: Error) => {
          assert.strictEqual(err, error);
          done();
        });
      });

      it('should call setLabels with all label names', done => {
        const labels = {
          labelone: 'labelonevalue',
          labeltwo: 'labeltwovalue',
        };

        bucket.getLabels = (callback: Function) => {
          callback(null, labels);
        };

        bucket.setLabels = (labels: {}, callback: Function) => {
          assert.deepStrictEqual(labels, {
            labelone: null,
            labeltwo: null,
          });
          callback();  // done()
        };

        bucket.deleteLabels(done);
      });
    });

    describe('single label', () => {
      const LABEL = 'labelname';

      it('should call setLabels with a single label', done => {
        bucket.setLabels = (labels: {}, callback: Function) => {
          assert.deepStrictEqual(labels, {
            [LABEL]: null,
          });
          callback();  // done()
        };

        bucket.deleteLabels(LABEL, done);
      });
    });

    describe('multiple labels', () => {
      const LABELS = ['labelonename', 'labeltwoname'];

      it('should call setLabels with multiple labels', done => {
        bucket.setLabels = (labels: {}, callback: Function) => {
          assert.deepStrictEqual(labels, {
            labelonename: null,
            labeltwoname: null,
          });
          callback();  // done()
        };

        bucket.deleteLabels(LABELS, done);
      });
    });
  });

  describe('disableRequesterPays', () => {
    it('should call setMetadata correctly', done => {
      bucket.setMetadata = (metadata: {}, callback: Function) => {
        assert.deepStrictEqual(metadata, {
          billing: {
            requesterPays: false,
          },
        });
        callback();  // done()
      };

      bucket.disableRequesterPays(done);
    });

    it('should not require a callback', done => {
      bucket.setMetadata = (metadata: {}, callback: Function) => {
        assert.doesNotThrow(callback);
        done();
      };

      bucket.disableRequesterPays();
    });
  });

  describe('enableRequesterPays', () => {
    it('should call setMetadata correctly', done => {
      bucket.setMetadata = (metadata: {}, callback: Function) => {
        assert.deepStrictEqual(metadata, {
          billing: {
            requesterPays: true,
          },
        });
        callback();  // done()
      };

      bucket.enableRequesterPays(done);
    });

    it('should not require a callback', done => {
      bucket.setMetadata = (metadata: {}, callback: Function) => {
        assert.doesNotThrow(callback);
        done();
      };

      bucket.enableRequesterPays();
    });
  });

  describe('exists', () => {
    it('should call get', done => {
      bucket.get = () => {
        done();
      };

      bucket.exists(assert.ifError);
    });

    it('should accept and pass options to get', done => {
      const options = {};

      bucket.get = (options_: {}) => {
        assert.strictEqual(options_, options);
        done();
      };

      bucket.exists(options, assert.ifError);
    });

    it('should execute callback with false if 404', done => {
      bucket.get = (options: {}, callback: Function) => {
        callback({code: 404});
      };

      bucket.exists((err: Error, exists: boolean) => {
        assert.ifError(err);
        assert.strictEqual(exists, false);
        done();
      });
    });

    it('should execute callback with error if not 404', done => {
      const error = {code: 500};

      bucket.get = (options: {}, callback: Function) => {
        callback(error);
      };

      bucket.exists((err: Error, exists: boolean) => {
        assert.strictEqual(err, error);
        assert.strictEqual(exists, undefined);
        done();
      });
    });

    it('should execute callback with true if no error', done => {
      bucket.get = (options: {}, callback: Function) => {
        callback();
      };

      bucket.exists((err: Error, exists: boolean) => {
        assert.ifError(err);
        assert.strictEqual(exists, true);
        done();
      });
    });
  });

  describe('file', () => {
    const FILE_NAME = 'remote-file-name.jpg';
    let file: File;
    const options = {a: 'b', c: 'd'};

    beforeEach(() => {
      file = bucket.file(FILE_NAME, options);
    });

    it('should throw if no name is provided', () => {
      assert.throws(() => {
        bucket.file();
      }, /A file name must be specified\./);
    });

    it('should return a File object', () => {
      assert(file instanceof FakeFile);
    });

    it('should pass bucket to File object', () => {
      assert.deepStrictEqual(file.calledWith_[0], bucket);
    });

    it('should pass filename to File object', () => {
      assert.strictEqual(file.calledWith_[1], FILE_NAME);
    });

    it('should pass configuration object to File', () => {
      assert.deepStrictEqual(file.calledWith_[2], options);
    });
  });

  describe('get', () => {
    it('should get the metadata', done => {
      bucket.getMetadata = () => {
        done();
      };

      bucket.get(assert.ifError);
    });

    it('should accept an options object', done => {
      const options = {};

      bucket.getMetadata = (options_: {}) => {
        assert.strictEqual(options_, options);
        done();
      };

      bucket.get(options, assert.ifError);
    });

    it('should execute callback with error & metadata', done => {
      const error = new Error('Error.');
      const metadata = {};

      bucket.getMetadata = (options: {}, callback: Function) => {
        callback(error, metadata);
      };

      bucket.get((err: Error, instance: {}, metadata_: {}) => {
        assert.strictEqual(err, error);
        assert.strictEqual(instance, null);
        assert.strictEqual(metadata_, metadata);

        done();
      });
    });

    it('should execute callback with instance & metadata', done => {
      const metadata = {};

      bucket.getMetadata = (options: {}, callback: Function) => {
        callback(null, metadata);
      };

      bucket.get((err: Error, instance: {}, metadata_: {}) => {
        assert.ifError(err);

        assert.strictEqual(instance, bucket);
        assert.strictEqual(metadata_, metadata);

        done();
      });
    });

    describe('autoCreate', () => {
      let AUTO_CREATE_CONFIG: {};

      const ERROR = {code: 404};
      const METADATA = {};

      beforeEach(() => {
        AUTO_CREATE_CONFIG = {
          autoCreate: true,
        };

        bucket.getMetadata = (options: {}, callback: Function) => {
          callback(ERROR, METADATA);
        };
      });

      it('should pass config to create if it was provided', done => {
        const config = extend({}, AUTO_CREATE_CONFIG, {
          maxResults: 5,
        });

        bucket.create = (config_: {}) => {
          assert.strictEqual(config_, config);
          done();
        };

        bucket.get(config, assert.ifError);
      });

      it('should pass only a callback to create if no config', done => {
        bucket.create = (callback: Function) => {
          callback();  // done()
        };

        bucket.get(AUTO_CREATE_CONFIG, done);
      });

      describe('error', () => {
        it('should execute callback with error & API response', done => {
          const error = new Error('Error.');
          const apiResponse = {};

          bucket.create = (callback: Function) => {
            bucket.get = (config: {}, callback: Function) => {
              assert.deepStrictEqual(config, {});
              callback();  // done()
            };

            callback(error, null, apiResponse);
          };

          bucket.get(
              AUTO_CREATE_CONFIG, (err: Error, instance: {}, resp: {}) => {
                assert.strictEqual(err, error);
                assert.strictEqual(instance, null);
                assert.strictEqual(resp, apiResponse);
                done();
              });
        });

        it('should refresh the metadata after a 409', done => {
          const error = {
            code: 409,
          };

          bucket.create = (callback: Function) => {
            bucket.get = (config: {}, callback: Function) => {
              assert.deepStrictEqual(config, {});
              callback();  // done()
            };
            callback(error);
          };

          bucket.get(AUTO_CREATE_CONFIG, done);
        });
      });
    });
  });

  describe('getFiles', () => {
    it('should get files without a query', done => {
      bucket.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(reqOpts.uri, '/o');
        assert.deepStrictEqual(reqOpts.qs, {});
        done();
      };

      bucket.getFiles(util.noop);
    });

    it('should get files with a query', done => {
      const token = 'next-page-token';
      bucket.request = (reqOpts: DecorateRequestOptions) => {
        assert.deepStrictEqual(reqOpts.qs, {maxResults: 5, pageToken: token});
        done();
      };
      bucket.getFiles({maxResults: 5, pageToken: token}, util.noop);
    });

    it('should allow setting a directory', done => {
      const directory = 'directory-name';
      bucket.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(reqOpts.qs.prefix, `${directory}/`);
        assert.strictEqual(reqOpts.qs.directory, undefined);
        done();
      };
      bucket.getFiles({directory}, assert.ifError);
    });

    it('should strip excess slashes from a directory', done => {
      const directory = 'directory-name///';
      bucket.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(reqOpts.qs.prefix, `directory-name/`);
        done();
      };
      bucket.getFiles({directory}, assert.ifError);
    });

    it('should return nextQuery if more results exist', () => {
      const token = 'next-page-token';
      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(null, {nextPageToken: token, items: []});
          };
      bucket.getFiles(
          {maxResults: 5},
          (err: Error, results: {}, nextQuery: GetFilesOptions) => {
            assert.strictEqual(nextQuery.pageToken, token);
            assert.strictEqual(nextQuery.maxResults, 5);
          });
    });

    it('should return null nextQuery if there are no more results', () => {
      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(null, {items: []});
          };
      bucket.getFiles(
          {maxResults: 5}, (err: Error, results: {}, nextQuery: {}) => {
            assert.strictEqual(nextQuery, null);
          });
    });

    it('should return File objects', done => {
      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(null, {
              items: [{name: 'fake-file-name', generation: 1}],
            });
          };
      bucket.getFiles((err: Error, files: FakeFile[]) => {
        assert.ifError(err);
        assert(files[0] instanceof FakeFile);
        assert.strictEqual(
            typeof files[0].calledWith_[2].generation, 'undefined');
        done();
      });
    });

    it('should return versioned Files if queried for versions', done => {
      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(null, {
              items: [{name: 'fake-file-name', generation: 1}],
            });
          };

      bucket.getFiles({versions: true}, (err: Error, files: FakeFile[]) => {
        assert.ifError(err);
        assert(files[0] instanceof FakeFile);
        assert.strictEqual(files[0].calledWith_[2].generation, 1);
        done();
      });
    });

    it('should set kmsKeyName on file', done => {
      const kmsKeyName = 'kms-key-name';

      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(null, {
              items: [{name: 'fake-file-name', kmsKeyName}],
            });
          };

      bucket.getFiles({versions: true}, (err: Error, files: FakeFile[]) => {
        assert.ifError(err);
        assert.strictEqual(files[0].calledWith_[2].kmsKeyName, kmsKeyName);
        done();
      });
    });

    it('should return apiResponse in callback', done => {
      const resp = {items: [{name: 'fake-file-name'}]};
      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(null, resp);
          };
      bucket.getFiles(
          (err: Error, files: Array<{}>, nextQuery: {}, apiResponse: {}) => {
            assert.deepStrictEqual(resp, apiResponse);
            done();
          });
    });

    it('should execute callback with error & API response', done => {
      const error = new Error('Error.');
      const apiResponse = {};

      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(error, apiResponse);
          };

      bucket.getFiles(
          (err: Error, files: File[], nextQuery: {}, apiResponse_: {}) => {
            assert.strictEqual(err, error);
            assert.strictEqual(files, null);
            assert.strictEqual(nextQuery, null);
            assert.strictEqual(apiResponse_, apiResponse);

            done();
          });
    });

    it('should populate returned File object with metadata', done => {
      const fileMetadata = {
        name: 'filename',
        contentType: 'x-zebra',
        metadata: {
          my: 'custom metadata',
        },
      };
      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(null, {items: [fileMetadata]});
          };
      bucket.getFiles((err: Error, files: FakeFile[]) => {
        assert.ifError(err);
        assert.deepStrictEqual(files[0].metadata, fileMetadata);
        done();
      });
    });
  });

  describe('getLabels', () => {
    it('should refresh metadata', done => {
      bucket.getMetadata = () => {
        done();
      };

      bucket.getLabels(assert.ifError);
    });

    it('should accept an options object', done => {
      const options = {};

      bucket.getMetadata = (options_: {}) => {
        assert.strictEqual(options_, options);
        done();
      };

      bucket.getLabels(options, assert.ifError);
    });

    it('should return error from getMetadata', done => {
      const error = new Error('Error.');

      bucket.getMetadata = (options: {}, callback: Function) => {
        callback(error);
      };

      bucket.getLabels((err: Error) => {
        assert.strictEqual(err, error);
        done();
      });
    });

    it('should return labels metadata property', done => {
      const metadata = {
        labels: {
          label: 'labelvalue',
        },
      };

      bucket.getMetadata = (options: {}, callback: Function) => {
        callback(null, metadata);
      };

      bucket.getLabels((err: Error, labels: {}) => {
        assert.ifError(err);
        assert.strictEqual(labels, metadata.labels);
        done();
      });
    });

    it('should return empty object if no labels exist', done => {
      const metadata = {};

      bucket.getMetadata = (options: {}, callback: Function) => {
        callback(null, metadata);
      };

      bucket.getLabels((err: Error, labels: {}) => {
        assert.ifError(err);
        assert.deepStrictEqual(labels, {});
        done();
      });
    });
  });

  describe('getMetadata', () => {
    it('should make the correct request', done => {
      bucket.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(reqOpts.uri, '');
        assert.deepStrictEqual(reqOpts.qs, {});
        done();
      };

      bucket.getMetadata(assert.ifError);
    });

    it('should accept options', done => {
      const options = {};

      bucket.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(reqOpts.qs, options);
        done();
      };

      bucket.getMetadata(options, assert.ifError);
    });

    it('should execute callback with error & apiResponse', done => {
      const error = new Error('Error.');
      const apiResponse = {};

      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(error, apiResponse);
          };

      bucket.getMetadata((err: Error, metadata: {}, apiResponse_: {}) => {
        assert.strictEqual(err, error);
        assert.strictEqual(metadata, null);
        assert.strictEqual(apiResponse_, apiResponse);
        done();
      });
    });

    it('should update metadata', done => {
      const apiResponse = {};

      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(null, apiResponse);
          };

      bucket.getMetadata((err: Error) => {
        assert.ifError(err);
        assert.strictEqual(bucket.metadata, apiResponse);
        done();
      });
    });

    it('should execute callback with metadata & API response', done => {
      const apiResponse = {};
      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(null, apiResponse);
          };

      bucket.getMetadata((err: Error, metadata: {}, apiResponse_: {}) => {
        assert.ifError(err);
        assert.strictEqual(metadata, apiResponse);
        assert.strictEqual(apiResponse_, apiResponse);
        done();
      });
    });
  });

  describe('getNotifications', () => {
    it('should make the correct request', done => {
      const options = {};

      bucket.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(reqOpts.uri, '/notificationConfigs');
        assert.strictEqual(reqOpts.qs, options);
        done();
      };

      bucket.getNotifications(options, assert.ifError);
    });

    it('should optionally accept options', done => {
      bucket.request = (reqOpts: DecorateRequestOptions) => {
        assert.deepStrictEqual(reqOpts.qs, {});
        done();
      };

      bucket.getNotifications(assert.ifError);
    });

    it('should return any errors to the callback', done => {
      const error = new Error('err');
      const response = {};

      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(error, response);
          };

      bucket.getNotifications(
          (err: Error, notifications: Notification[], resp: {}) => {
            assert.strictEqual(err, error);
            assert.strictEqual(notifications, null);
            assert.strictEqual(resp, response);
            done();
          });
    });

    it('should return a list of notification objects', done => {
      const fakeItems = [{id: '1'}, {id: '2'}, {id: '3'}];
      const response = {items: fakeItems};

      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(null, response);
          };

      let callCount = 0;
      const fakeNotifications = [{}, {}, {}];

      bucket.notification = (id: string) => {
        const expectedId = fakeItems[callCount].id;
        assert.strictEqual(id, expectedId);
        return fakeNotifications[callCount++];
      };

      bucket.getNotifications(
          (err: Error, notifications: Notification[], resp: {}) => {
            assert.ifError(err);
            notifications.forEach((notification, i) => {
              assert.strictEqual(notification, fakeNotifications[i]);
              assert.strictEqual(notification.metadata, fakeItems[i]);
            });
            assert.strictEqual(resp, response);
            done();
          });
    });
  });

  describe('lock', () => {
    it('should throw if a metageneration is not provided', () => {
      const expectedError = new RegExp('A metageneration must be provided.');

      assert.throws(() => {
        bucket.lock(assert.ifError);
      }, expectedError);
    });

    it('should make the correct request', done => {
      const metageneration = 8;

      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            assert.deepStrictEqual(reqOpts, {
              method: 'POST',
              uri: '/lockRetentionPolicy',
              qs: {
                ifMetagenerationMatch: metageneration,
              },
            });

            callback();  // done()
          };

      bucket.lock(metageneration, done);
    });
  });

  describe('makePrivate', () => {
    it('should set predefinedAcl & privatize files', done => {
      let didSetPredefinedAcl = false;
      let didMakeFilesPrivate = false;

      bucket.setMetadata = (metadata: {}, options: {}, callback: Function) => {
        assert.deepStrictEqual(metadata, {acl: null});
        assert.deepStrictEqual(options, {predefinedAcl: 'projectPrivate'});

        didSetPredefinedAcl = true;
        callback();
      };

      bucket.makeAllFilesPublicPrivate_ =
          (opts: MakeAllFilesPublicPrivateOptions, callback: Function) => {
            assert.strictEqual(opts.private, true);
            assert.strictEqual(opts.force, true);
            didMakeFilesPrivate = true;
            callback();
          };

      bucket.makePrivate({includeFiles: true, force: true}, (err: Error) => {
        assert.ifError(err);
        assert(didSetPredefinedAcl);
        assert(didMakeFilesPrivate);
        done();
      });
    });

    it('should accept userProject', done => {
      const options = {
        userProject: 'user-project-id',
      };
      bucket.setMetadata = (metadata: {}, options_: SetFileMetadataOptions) => {
        assert.strictEqual(options_.userProject, options.userProject);
        done();
      };
      bucket.makePrivate(options, assert.ifError);
    });

    it('should not make files private by default', done => {
      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback();
          };

      bucket.makeAllFilesPublicPrivate_ = () => {
        throw new Error('Please, no. I do not want to be called.');
      };

      bucket.makePrivate(done);
    });

    it('should execute callback with error', done => {
      const error = new Error('Error.');

      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(error);
          };

      bucket.makePrivate((err: Error) => {
        assert.strictEqual(err, error);
        done();
      });
    });
  });

  describe('makePublic', () => {
    beforeEach(() => {
      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback();
          };
    });

    it('should set ACL, default ACL, and publicize files', done => {
      let didSetAcl = false;
      let didSetDefaultAcl = false;
      let didMakeFilesPublic = false;

      bucket.acl.add = (opts: AddAclOptions, callback: Function) => {
        assert.strictEqual(opts.entity, 'allUsers');
        assert.strictEqual(opts.role, 'READER');
        didSetAcl = true;
        callback();
      };

      bucket.acl.default.add = (opts: AddAclOptions, callback: Function) => {
        assert.strictEqual(opts.entity, 'allUsers');
        assert.strictEqual(opts.role, 'READER');
        didSetDefaultAcl = true;
        callback();
      };

      bucket.makeAllFilesPublicPrivate_ =
          (opts: MakeAllFilesPublicPrivateOptions, callback: Function) => {
            assert.strictEqual(opts.public, true);
            assert.strictEqual(opts.force, true);
            didMakeFilesPublic = true;
            callback();
          };

      bucket.makePublic(
          {
            includeFiles: true,
            force: true,
          },
          (err: Error) => {
            assert.ifError(err);
            assert(didSetAcl);
            assert(didSetDefaultAcl);
            assert(didMakeFilesPublic);
            done();
          });
    });

    it('should not make files public by default', done => {
      bucket.acl.add = (opts: {}, callback: Function) => {
        callback();
      };

      bucket.acl.default.add = (opts: {}, callback: Function) => {
        callback();
      };

      bucket.makeAllFilesPublicPrivate_ = () => {
        throw new Error('Please, no. I do not want to be called.');
      };

      bucket.makePublic(done);
    });

    it('should execute callback with error', done => {
      const error = new Error('Error.');

      bucket.acl.add = (opts: {}, callback: Function) => {
        callback(error);
      };

      bucket.makePublic((err: Error) => {
        assert.strictEqual(err, error);
        done();
      });
    });
  });

  describe('notification', () => {
    it('should throw an error if an id is not provided', () => {
      assert.throws(() => {
        bucket.notification();
      }, /You must supply a notification ID\./);
    });

    it('should return a Notification object', () => {
      const fakeId = '123';
      const notification = bucket.notification(fakeId);

      assert(notification instanceof FakeNotification);
      assert.strictEqual(notification.bucket, bucket);
      assert.strictEqual(notification.id, fakeId);
    });
  });

  describe('removeRetentionPeriod', () => {
    it('should call setMetadata correctly', done => {
      bucket.setMetadata = (metadata: {}, callback: Function) => {
        assert.deepStrictEqual(metadata, {
          retentionPolicy: null,
        });

        callback();  // done()
      };

      bucket.removeRetentionPeriod(done);
    });
  });

  describe('request', () => {
    const USER_PROJECT = 'grape-spaceship-123';

    beforeEach(() => {
      bucket.userProject = USER_PROJECT;
    });

    it('should set the userProject if qs is undefined', done => {
      FakeServiceObject.prototype.request =
          ((reqOpts: DecorateRequestOptions) => {
            assert.strictEqual(reqOpts.qs.userProject, USER_PROJECT);
            done();
            // tslint:disable-next-line:no-any
          }) as any;

      bucket.request({}, assert.ifError);
    });

    it('should set the userProject if field is undefined', done => {
      const options = {
        qs: {
          foo: 'bar',
        },
      };

      FakeServiceObject.prototype.request =
          ((reqOpts: DecorateRequestOptions) => {
            assert.strictEqual(reqOpts.qs, options.qs);
            assert.strictEqual(reqOpts.qs.userProject, USER_PROJECT);
            done();
            // tslint:disable-next-line:no-any
          }) as any;

      bucket.request(options, assert.ifError);
    });

    it('should not overwrite the userProject', done => {
      const fakeUserProject = 'not-grape-spaceship-123';
      const options = {
        qs: {
          userProject: fakeUserProject,
        },
      };

      FakeServiceObject.prototype.request =
          ((reqOpts: DecorateRequestOptions) => {
            assert.strictEqual(reqOpts.qs.userProject, fakeUserProject);
            done();
            // tslint:disable-next-line:no-any
          }) as any;

      bucket.request(options, assert.ifError);
    });

    it('should call ServiceObject#request correctly', done => {
      const options = {};

      extend(FakeServiceObject.prototype, {
        request(reqOpts: DecorateRequestOptions, callback: Function) {
          assert.strictEqual(this, bucket);
          assert.strictEqual(reqOpts, options);
          callback();  // done fn
        },
      });

      bucket.request(options, done);
    });
  });

  describe('setLabels', () => {
    it('should correctly call setMetadata', done => {
      const labels = {};
      bucket.setMetadata =
          (metadata: Metadata, options: {}, callback: Function) => {
            assert.strictEqual(metadata.labels, labels);
            callback();  // done()
          };
      bucket.setLabels(labels, done);
    });

    it('should accept an options object', done => {
      const labels = {};
      const options = {};
      bucket.setMetadata = (metadata: {}, options_: {}) => {
        assert.strictEqual(options_, options);
        done();
      };
      bucket.setLabels(labels, options, done);
    });
  });

  describe('setMetadata', () => {
    it('should make the correct request', done => {
      const metadata = {};
      bucket.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(reqOpts.method, 'PATCH');
        assert.strictEqual(reqOpts.uri, '');
        assert.strictEqual(reqOpts.json, metadata);
        assert.deepStrictEqual(reqOpts.qs, {});
        done();
      };
      bucket.setMetadata(metadata, assert.ifError);
    });

    it('should not require a callback', done => {
      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            assert.doesNotThrow(callback);
            done();
          };
      bucket.setMetadata({});
    });

    it('should accept options', done => {
      const options = {};
      bucket.request = (reqOpts: DecorateRequestOptions) => {
        assert.strictEqual(reqOpts.qs, options);
        done();
      };
      bucket.setMetadata({}, options, assert.ifError);
    });

    it('should execute callback with error & apiResponse', done => {
      const error = new Error('Error.');
      const apiResponse = {};
      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(error, apiResponse);
          };

      bucket.setMetadata({}, (err: Error, apiResponse_: {}) => {
        assert.strictEqual(err, error);
        assert.strictEqual(apiResponse_, apiResponse);
        done();
      });
    });

    it('should update metadata', done => {
      const apiResponse = {};

      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(null, apiResponse);
          };

      bucket.setMetadata({}, (err: Error) => {
        assert.ifError(err);
        assert.strictEqual(bucket.metadata, apiResponse);
        done();
      });
    });

    it('should execute callback with metadata & API response', done => {
      const apiResponse = {};

      bucket.request =
          (reqOpts: DecorateRequestOptions, callback: Function) => {
            callback(null, apiResponse);
          };

      bucket.setMetadata({}, (err: Error, apiResponse_: {}) => {
        assert.ifError(err);
        assert.strictEqual(apiResponse_, apiResponse);
        done();
      });
    });
  });

  describe('setRetentionPeriod', () => {
    it('should call setMetadata correctly', done => {
      const duration = 90000;

      bucket.setMetadata = (metadata: {}, callback: Function) => {
        assert.deepStrictEqual(metadata, {
          retentionPolicy: {
            retentionPeriod: duration,
          },
        });

        callback();  // done()
      };

      bucket.setRetentionPeriod(duration, done);
    });
  });

  describe('setStorageClass', () => {
    const STORAGE_CLASS = 'NEW_STORAGE_CLASS';
    const OPTIONS = {};
    const CALLBACK = util.noop;

    it('should convert camelCase to snake_case', done => {
      bucket.setMetadata = (metadata: Metadata) => {
        assert.strictEqual(metadata.storageClass, 'CAMEL_CASE');
        done();
      };

      bucket.setStorageClass('camelCase', OPTIONS, CALLBACK);
    });

    it('should convert hyphenate to snake_case', done => {
      bucket.setMetadata = (metadata: Metadata) => {
        assert.strictEqual(metadata.storageClass, 'HYPHENATED_CLASS');
        done();
      };

      bucket.setStorageClass('hyphenated-class', OPTIONS, CALLBACK);
    });

    it('should call setMetdata correctly', done => {
      bucket.setMetadata =
          (metadata: Metadata, options: {}, callback: Function) => {
            assert.deepStrictEqual(metadata, {storageClass: STORAGE_CLASS});
            assert.strictEqual(options, OPTIONS);
            assert.strictEqual(callback, CALLBACK);
            done();
          };

      bucket.setStorageClass(STORAGE_CLASS, OPTIONS, CALLBACK);
    });
  });

  describe('setUserProject', () => {
    it('should set the userProject property', () => {
      const userProject = 'grape-spaceship-123';

      bucket.setUserProject(userProject);
      assert.strictEqual(bucket.userProject, userProject);
    });
  });

  describe('upload', () => {
    const basename = 'testfile.json';
    const filepath = path.join(__dirname, '../../test/testdata/' + basename);
    const textFilepath =
        path.join(__dirname, '../../test/testdata/textfile.txt');
    const metadata = {
      metadata: {
        a: 'b',
        c: 'd',
      },
    };

    beforeEach(() => {
      bucket.file = (name: string, metadata: Metadata) => {
        return new FakeFile(bucket, name, metadata);
      };
    });

    it('should return early in snippet sandbox', () => {
      // tslint:disable-next-line:no-any
      (global as any)['GCLOUD_SANDBOX_ENV'] = true;
      const returnValue = bucket.upload(filepath, assert.ifError);
      // tslint:disable-next-line:no-any
      delete (global as any)['GCLOUD_SANDBOX_ENV'];
      assert.strictEqual(returnValue, undefined);
    });

    it('should accept a path & cb', done => {
      bucket.upload(filepath, (err: Error, file: File) => {
        assert.ifError(err);
        assert.strictEqual(file.bucket.name, bucket.name);
        assert.strictEqual(file.name, basename);
        done();
      });
    });

    it('should accept a path, metadata, & cb', done => {
      const options = {
        metadata,
        encryptionKey: 'key',
        kmsKeyName: 'kms-key-name',
      };
      bucket.upload(filepath, options, (err: Error, file: File) => {
        assert.ifError(err);
        assert.strictEqual(file.bucket.name, bucket.name);
        assert.deepStrictEqual(file.metadata, metadata);
        assert.strictEqual(file.options.encryptionKey, options.encryptionKey);
        assert.strictEqual(file.options.kmsKeyName, options.kmsKeyName);
        done();
      });
    });

    it('should accept a path, a string dest, & cb', done => {
      const newFileName = 'new-file-name.png';
      const options = {
        destination: newFileName,
        encryptionKey: 'key',
        kmsKeyName: 'kms-key-name',
      };
      bucket.upload(filepath, options, (err: Error, file: File) => {
        assert.ifError(err);
        assert.strictEqual(file.bucket.name, bucket.name);
        assert.strictEqual(file.name, newFileName);
        assert.strictEqual(file.options.encryptionKey, options.encryptionKey);
        assert.strictEqual(file.options.kmsKeyName, options.kmsKeyName);
        done();
      });
    });

    it('should accept a path, a string dest, metadata, & cb', done => {
      const newFileName = 'new-file-name.png';
      const options = {
        destination: newFileName,
        metadata,
        encryptionKey: 'key',
        kmsKeyName: 'kms-key-name',
      };
      bucket.upload(filepath, options, (err: Error, file: File) => {
        assert.ifError(err);
        assert.strictEqual(file.bucket.name, bucket.name);
        assert.strictEqual(file.name, newFileName);
        assert.deepStrictEqual(file.metadata, metadata);
        assert.strictEqual(file.options.encryptionKey, options.encryptionKey);
        assert.strictEqual(file.options.kmsKeyName, options.kmsKeyName);
        done();
      });
    });

    it('should accept a path, a File dest, & cb', done => {
      const fakeFile = new FakeFile(bucket, 'file-name');
      fakeFile.isSameFile = () => {
        return true;
      };
      const options = {destination: fakeFile};
      bucket.upload(filepath, options, (err: Error, file: File) => {
        assert.ifError(err);
        assert(file.isSameFile());
        done();
      });
    });

    it('should accept a path, a File dest, metadata, & cb', done => {
      const fakeFile = new FakeFile(bucket, 'file-name');
      fakeFile.isSameFile = () => {
        return true;
      };
      const options = {destination: fakeFile, metadata};
      bucket.upload(filepath, options, (err: Error, file: File) => {
        assert.ifError(err);
        assert(file.isSameFile());
        assert.deepStrictEqual(file.metadata, metadata);
        done();
      });
    });

    it('should guess at the content type', done => {
      const fakeFile = new FakeFile(bucket, 'file-name');
      const options = {destination: fakeFile};
      fakeFile.createWriteStream = (options: CreateWriteStreamOptions) => {
        const ws = new stream.Writable();
        ws.write = () => true;
        setImmediate(() => {
          const expectedContentType = 'application/json; charset=utf-8';
          assert.strictEqual(options.metadata.contentType, expectedContentType);
          done();
        });
        return ws;
      };
      bucket.upload(filepath, options, assert.ifError);
    });

    it('should guess at the charset', done => {
      const fakeFile = new FakeFile(bucket, 'file-name');
      const options = {destination: fakeFile};
      fakeFile.createWriteStream = (options: CreateWriteStreamOptions) => {
        const ws = new stream.Writable();
        ws.write = () => true;
        setImmediate(() => {
          const expectedContentType = 'text/plain; charset=utf-8';
          assert.strictEqual(options.metadata.contentType, expectedContentType);
          done();
        });
        return ws;
      };
      bucket.upload(textFilepath, options, assert.ifError);
    });

    it('should force a resumable upload', done => {
      const fakeFile = new FakeFile(bucket, 'file-name');
      const options = {destination: fakeFile, resumable: true};
      fakeFile.createWriteStream = (options_: CreateWriteStreamOptions) => {
        const ws = new stream.Writable();
        ws.write = () => true;
        setImmediate(() => {
          assert.strictEqual(options_.resumable, options.resumable);
          done();
        });
        return ws;
      };
      bucket.upload(filepath, options, assert.ifError);
    });

    it('should allow overriding content type', done => {
      const fakeFile = new FakeFile(bucket, 'file-name');
      const metadata = {contentType: 'made-up-content-type'};
      const options = {destination: fakeFile, metadata};
      fakeFile.createWriteStream = (options: CreateWriteStreamOptions) => {
        const ws = new stream.Writable();
        ws.write = () => true;
        setImmediate(() => {
          assert.strictEqual(
              options.metadata.contentType, metadata.contentType);
          done();
        });
        return ws;
      };
      bucket.upload(filepath, options, assert.ifError);
    });

    it('should pass provided options to createWriteStream', done => {
      const fakeFile = new FakeFile(bucket, 'file-name');
      const options = {
        destination: fakeFile,
        a: 'b',
        c: 'd',
      };
      fakeFile.createWriteStream = (options_: {a: {}, c: {}}) => {
        const ws = new stream.Writable();
        ws.write = () => true;
        setImmediate(() => {
          assert.strictEqual(options_.a, options.a);
          assert.strictEqual(options_.c, options.c);
          done();
        });
        return ws;
      };
      bucket.upload(filepath, options, assert.ifError);
    });

    it('should execute callback on error', done => {
      const error = new Error('Error.');
      const fakeFile = new FakeFile(bucket, 'file-name');
      const options = {destination: fakeFile};
      fakeFile.createWriteStream = () => {
        const ws = through();
        setImmediate(() => {
          ws.destroy(error);
        });
        return ws;
      };
      bucket.upload(filepath, options, (err: Error) => {
        assert.strictEqual(err, error);
        done();
      });
    });

    it('should return file and metadata', done => {
      const fakeFile = new FakeFile(bucket, 'file-name');
      const options = {destination: fakeFile};
      const metadata = {};

      fakeFile.createWriteStream = () => {
        const ws = through();
        setImmediate(() => {
          fakeFile.metadata = metadata;
          ws.end();
        });
        return ws;
      };

      bucket.upload(
          filepath, options, (err: Error, file: File, apiResponse: {}) => {
            assert.ifError(err);
            assert.strictEqual(file, fakeFile);
            assert.strictEqual(apiResponse, metadata);
            done();
          });
    });
  });

  describe('makeAllFilesPublicPrivate_', () => {
    it('should get all files from the bucket', done => {
      const options = {};
      bucket.getFiles = (options_: {}) => {
        assert.strictEqual(options_, options);
        done();
      };
      bucket.makeAllFilesPublicPrivate_(options, assert.ifError);
    });

    it('should process 10 files at a time', done => {
      eachLimitOverride = (arr: {}, limit: number) => {
        assert.strictEqual(limit, 10);
        done();
      };
      bucket.getFiles = (options: {}, callback: Function) => {
        callback(null, []);
      };
      bucket.makeAllFilesPublicPrivate_({}, assert.ifError);
    });

    it('should make files public', done => {
      let timesCalled = 0;
      const files = [bucket.file('1'), bucket.file('2')].map(file => {
        file.makePublic = (callback: Function) => {
          timesCalled++;
          callback();
        };
        return file;
      });

      bucket.getFiles = (options: {}, callback: Function) => {
        callback(null, files);
      };

      bucket.makeAllFilesPublicPrivate_({public: true}, (err: Error) => {
        assert.ifError(err);
        assert.strictEqual(timesCalled, files.length);
        done();
      });
    });

    it('should make files private', done => {
      const options = {
        private: true,
      };
      let timesCalled = 0;

      const files = [bucket.file('1'), bucket.file('2')].map(file => {
        file.makePrivate = (options_: {}, callback: Function) => {
          timesCalled++;
          callback();
        };
        return file;
      });

      bucket.getFiles = (options_: {}, callback: Function) => {
        callback(null, files);
      };

      bucket.makeAllFilesPublicPrivate_(options, (err: Error) => {
        assert.ifError(err);
        assert.strictEqual(timesCalled, files.length);
        done();
      });
    });

    it('should execute callback with error from getting files', done => {
      const error = new Error('Error.');

      bucket.getFiles = (options: {}, callback: Function) => {
        callback(error);
      };

      bucket.makeAllFilesPublicPrivate_({}, (err: Error) => {
        assert.strictEqual(err, error);
        done();
      });
    });

    it('should execute callback with error from changing file', done => {
      const error = new Error('Error.');

      const files = [bucket.file('1'), bucket.file('2')].map(file => {
        file.makePublic = (callback: Function) => callback(error);
        return file;
      });

      bucket.getFiles = (options: {}, callback: Function) => {
        callback(null, files);
      };

      bucket.makeAllFilesPublicPrivate_({public: true}, (err: Error) => {
        assert.strictEqual(err, error);
        done();
      });
    });

    it('should execute callback with queued errors', done => {
      const error = new Error('Error.');

      const files = [bucket.file('1'), bucket.file('2')].map(file => {
        file.makePublic = (callback: Function) => callback(error);
        return file;
      });

      bucket.getFiles = (options: {}, callback: Function) => {
        callback(null, files);
      };

      bucket.makeAllFilesPublicPrivate_(
          {
            public: true,
            force: true,
          },
          (errs: Error[]) => {
            assert.deepStrictEqual(errs, [error, error]);
            done();
          });
    });

    it('should execute callback with files changed', done => {
      const error = new Error('Error.');
      const successFiles = [bucket.file('1'), bucket.file('2')].map(file => {
        file.makePublic = (callback: Function) => callback();
        return file;
      });
      const errorFiles = [bucket.file('3'), bucket.file('4')].map(file => {
        file.makePublic = (callback: Function) => callback(error);
        return file;
      });

      bucket.getFiles = (options: {}, callback: Function) => {
        callback(null, successFiles.concat(errorFiles));
      };

      bucket.makeAllFilesPublicPrivate_(
          {
            public: true,
            force: true,
          },
          (errs: Error[], files: File[]) => {
            assert.deepStrictEqual(errs, [error, error]);
            assert.deepStrictEqual(files, successFiles);
            done();
          });
    });
  });
});
