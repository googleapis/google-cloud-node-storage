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

import * as assert from 'assert';
import { Buffer } from 'safe-buffer';
import * as crypto from 'crypto';
let duplexify;
import * as extend from 'extend';
import * as fs from 'fs';
import * as nodeutil from 'util';
import * as proxyquire from 'proxyquire';
import * as request from 'request';
import * as stream from 'stream';
import * as through from 'through2';
import * as tmp from 'tmp';
import * as url from 'url';
import { ServiceObject, util } from '@google-cloud/common';
import * as zlib from 'zlib';

interface RequestAPI extends request.RequestAPI<request.Request, request.CoreOptions, {}> { }

interface RequestStub {
  (...args): RequestAPI;
  defaults?: (...args) => RequestStub;
  get?: typeof request.get;
  head?: typeof request.head;
}

const { Bucket } = require('../src/bucket.js');

let promisified = false;
let makeWritableStreamOverride;
let handleRespOverride;
const fakeUtil = extend({}, util, {
  handleResp() {
    (handleRespOverride || util.handleResp).apply(null, arguments);
  },

  makeWritableStream() {
    const args = arguments;
    (makeWritableStreamOverride || util.makeWritableStream).apply(null, args);
  },
});

const fakePromisify = {
  // tslint:disable-next-line:variable-name
  promisifyAll(Class, options) {
    if (Class.name !== 'File') {
      return;
    }

    promisified = true;
    assert.deepStrictEqual(options.exclude, ['request', 'setEncryptionKey']);
  },
};

const fsCached = extend(true, {}, fs);
const fakeFs = extend(true, {}, fsCached);

let REQUEST_DEFAULT_CONF; // eslint-disable-line no-unused-vars
const requestCached = request;
let requestOverride;
const fakeRequest: RequestStub = (...args) => {
  return (requestOverride || requestCached).apply(null, arguments);
};

fakeRequest.defaults = defaultConfiguration => {
  // Ignore the default values, so we don't have to test for them in every API
  // call.
  REQUEST_DEFAULT_CONF = defaultConfiguration;
  return fakeRequest;
};

let hashStreamValidationOverride;
const hashStreamValidation = require('hash-stream-validation');
function fakeHashStreamValidation() {
  return (hashStreamValidationOverride || hashStreamValidation).apply(
    null,
    arguments
  );
}

const osCached = extend(true, {}, require('os'));
const fakeOs = extend(true, {}, osCached);

let resumableUploadOverride;
const resumableUpload = require('gcs-resumable-upload');
function fakeResumableUpload() {
  return () => {
    return resumableUploadOverride || resumableUpload;
  };
}
extend(fakeResumableUpload, {
  createURI(...args) {
    let createURI = resumableUpload.createURI;

    if (resumableUploadOverride && resumableUploadOverride.createURI) {
      createURI = resumableUploadOverride.createURI;
    }

    return createURI.apply(null, args);
  },
});
extend(fakeResumableUpload, {
  upload(...args) {
    let upload = resumableUpload.upload;
    if (resumableUploadOverride && resumableUploadOverride.upload) {
      upload = resumableUploadOverride.upload;
    }
    return upload.apply(null, args);
  }
});

function FakeServiceObject() {
  this.calledWith_ = arguments;
  ServiceObject.apply(this, arguments);
}

nodeutil.inherits(FakeServiceObject, ServiceObject);

let xdgConfigOverride;
const xdgBasedirCached = require('xdg-basedir');
const fakeXdgBasedir = extend(true, {}, xdgBasedirCached);
Object.defineProperty(fakeXdgBasedir, 'config', {
  get() {
    return xdgConfigOverride === false
      ? false
      : xdgConfigOverride || xdgBasedirCached.config;
  },
});

describe('File', () => {
  // tslint:disable-next-line:variable-name
  let File;
  let file;

  const FILE_NAME = 'file-name.png';
  let directoryFile;

  let STORAGE;
  let BUCKET;

  before(() => {
    File = proxyquire('../src/file.js', {
      '@google-cloud/common': {
        ServiceObject: FakeServiceObject,
        util: fakeUtil,
      },
      '@google-cloud/promisify': fakePromisify,
      fs: fakeFs,
      'gcs-resumable-upload': fakeResumableUpload,
      'hash-stream-validation': fakeHashStreamValidation,
      os: fakeOs,
      request: fakeRequest,
      'xdg-basedir': fakeXdgBasedir,
    }).File;
    duplexify = require('duplexify');
  });

  beforeEach(() => {
    extend(true, fakeFs, fsCached);
    extend(true, fakeOs, osCached);
    xdgConfigOverride = null;
    FakeServiceObject.prototype.request = util.noop;

    STORAGE = {
      createBucket: util.noop,
      request: util.noop,
      makeAuthenticatedRequest(req, callback) {
        if (callback) {
          (callback.onAuthenticated || callback)(null, req);
        } else {
          return (requestOverride || requestCached)(req);
        }
      },
      bucket(name) {
        return new Bucket(this, name);
      },
    };

    BUCKET = new Bucket(STORAGE, 'bucket-name');
    file = new File(BUCKET, FILE_NAME);

    directoryFile = new File(BUCKET, 'directory/file.jpg');
    directoryFile.request = util.noop;

    handleRespOverride = null;
    hashStreamValidationOverride = null;
    makeWritableStreamOverride = null;
    requestOverride = null;
    resumableUploadOverride = null;
  });

  describe('initialization', () => {
    it('should promisify all the things', () => {
      assert(promisified);
    });

    it('should assign file name', () => {
      assert.strictEqual(file.name, FILE_NAME);
    });

    it('should assign the bucket instance', () => {
      assert.strictEqual(file.bucket, BUCKET);
    });

    it('should assign the storage instance', () => {
      assert.strictEqual(file.storage, BUCKET.storage);
    });

    it('should strip a single leading slash', () => {
      const file = new File(BUCKET, '/name');
      assert.strictEqual(file.name, 'name');
    });

    it('should assign KMS key name', () => {
      const kmsKeyName = 'kms-key-name';
      const file = new File(BUCKET, '/name', { kmsKeyName });
      assert.strictEqual(file.kmsKeyName, kmsKeyName);
    });

    it('should accept specifying a generation', () => {
      const file = new File(BUCKET, 'name', { generation: 2 });
      assert.strictEqual(file.generation, 2);
    });

    it('should build a requestQueryObject from generation', () => {
      const file = new File(BUCKET, 'name', { generation: 2 });
      assert.deepStrictEqual(file.requestQueryObject, {
        generation: 2,
      });
    });

    it('should inherit from ServiceObject', () => {
      assert(file instanceof ServiceObject);

      const calledWith = file.calledWith_[0];

      assert.strictEqual(calledWith.parent, BUCKET);
      assert.strictEqual(calledWith.baseUrl, '/o');
      assert.strictEqual(calledWith.id, encodeURIComponent(FILE_NAME));
    });

    it('should use stripped leading slash name in ServiceObject', () => {
      const file = new File(BUCKET, '/name');
      const calledWith = file.calledWith_[0];

      assert.strictEqual(calledWith.id, 'name');
    });

    it('should set a custom encryption key', done => {
      const key = 'key';

      const setEncryptionKey = File.prototype.setEncryptionKey;
      File.prototype.setEncryptionKey = key_ => {
        File.prototype.setEncryptionKey = setEncryptionKey;
        assert.strictEqual(key_, key);
        done();
      };

      const _file = new File(BUCKET, FILE_NAME, { encryptionKey: key });
    });

    describe('userProject', () => {
      const USER_PROJECT = 'grapce-spaceship-123';

      it('should localize the Bucket#userProject', () => {
        const bucket = new Bucket(STORAGE, 'bucket-name', {
          userProject: USER_PROJECT,
        });

        const file = new File(bucket, '/name');
        assert.strictEqual(file.userProject, USER_PROJECT);
      });

      it('should accept a userProject option', () => {
        const file = new File(BUCKET, '/name', {
          userProject: USER_PROJECT,
        });

        assert.strictEqual(file.userProject, USER_PROJECT);
      });
    });
  });

  describe('copy', () => {
    it('should throw if no destination is provided', () => {
      assert.throws(() => {
        file.copy();
      }, /Destination file should have a name\./);
    });

    it('should URI encode file names', done => {
      const newFile = new File(BUCKET, 'nested/file.jpg');

      const expectedPath = `/rewriteTo/b/${
        file.bucket.name
        }/o/${encodeURIComponent(newFile.name)}`;

      directoryFile.request = reqOpts => {
        assert.strictEqual(reqOpts.uri, expectedPath);
        done();
      };

      directoryFile.copy(newFile);
    });

    it('should execute callback with error & API response', done => {
      const error = new Error('Error.');
      const apiResponse = {};

      const newFile = new File(BUCKET, 'new-file');

      file.request = (reqOpts, callback) => {
        callback(error, apiResponse);
      };

      file.copy(newFile, (err, file, apiResponse_) => {
        assert.strictEqual(err, error);
        assert.strictEqual(file, null);
        assert.strictEqual(apiResponse_, apiResponse);

        done();
      });
    });

    it('should send query.sourceGeneration if File has one', done => {
      const versionedFile = new File(BUCKET, 'name', { generation: 1 });
      const newFile = new File(BUCKET, 'new-file');

      versionedFile.request = reqOpts => {
        assert.strictEqual(reqOpts.qs.sourceGeneration, 1);
        done();
      };

      versionedFile.copy(newFile, assert.ifError);
    });

    it('should accept an options object', done => {
      const newFile = new File(BUCKET, 'name');
      const options = {
        option: true,
      };

      file.request = reqOpts => {
        assert.deepStrictEqual(reqOpts.json, options);
        done();
      };

      file.copy(newFile, options, assert.ifError);
    });

    it('should pass through userProject', done => {
      const options = {
        userProject: 'user-project',
      };
      const originalOptions = extend({}, options);
      const newFile = new File(BUCKET, 'new-file');

      file.request = reqOpts => {
        assert.strictEqual(reqOpts.qs.userProject, options.userProject);
        assert.strictEqual(reqOpts.json.userProject, undefined);
        assert.deepStrictEqual(options, originalOptions);
        done();
      };

      file.copy(newFile, options, assert.ifError);
    });

    it('should set correct headers when file is encrypted', done => {
      file.encryptionKey = {};
      file.encryptionKeyBase64 = 'base64';
      file.encryptionKeyHash = 'hash';

      const newFile = new File(BUCKET, 'new-file');

      file.request = reqOpts => {
        assert.deepStrictEqual(reqOpts.headers, {
          'x-goog-copy-source-encryption-algorithm': 'AES256',
          'x-goog-copy-source-encryption-key': file.encryptionKeyBase64,
          'x-goog-copy-source-encryption-key-sha256': file.encryptionKeyHash,
        });
        done();
      };

      file.copy(newFile, assert.ifError);
    });

    it('should set encryption key on the new File instance', done => {
      const newFile = new File(BUCKET, 'new-file');
      newFile.encryptionKey = 'encryptionKey';

      file.setEncryptionKey = encryptionKey => {
        assert.strictEqual(encryptionKey, newFile.encryptionKey);
        done();
      };

      file.copy(newFile, assert.ifError);
    });

    it('should set destination KMS key name', done => {
      const newFile = new File(BUCKET, 'new-file');
      newFile.kmsKeyName = 'kms-key-name';

      file.request = reqOpts => {
        assert.strictEqual(
          reqOpts.qs.destinationKmsKeyName,
          newFile.kmsKeyName
        );
        assert.strictEqual(file.kmsKeyName, newFile.kmsKeyName);
        done();
      };

      file.copy(newFile, assert.ifError);
    });

    it('should set destination KMS key name from option', done => {
      const newFile = new File(BUCKET, 'new-file');
      const destinationKmsKeyName = 'destination-kms-key-name';

      file.request = reqOpts => {
        assert.strictEqual(
          reqOpts.qs.destinationKmsKeyName,
          destinationKmsKeyName
        );
        assert.strictEqual(file.kmsKeyName, destinationKmsKeyName);
        done();
      };

      file.copy(newFile, { destinationKmsKeyName }, assert.ifError);
    });

    it('should favor the option over the File KMS name', done => {
      const newFile = new File(BUCKET, 'new-file');
      newFile.kmsKeyName = 'incorrect-kms-key-name';
      const destinationKmsKeyName = 'correct-kms-key-name';

      file.request = reqOpts => {
        assert.strictEqual(
          reqOpts.qs.destinationKmsKeyName,
          destinationKmsKeyName
        );
        assert.strictEqual(file.kmsKeyName, destinationKmsKeyName);
        done();
      };

      file.copy(newFile, { destinationKmsKeyName }, assert.ifError);
    });

    it('should remove custom encryption interceptor if rotating to KMS', done => {
      const newFile = new File(BUCKET, 'new-file');
      const destinationKmsKeyName = 'correct-kms-key-name';

      file.encryptionKeyInterceptor = {};
      file.interceptors = [{}, file.encryptionKeyInterceptor, {}];

      file.request = () => {
        assert.strictEqual(file.interceptors.length, 2);
        assert(file.interceptors.indexOf(file.encryptionKeyInterceptor) === -1);
        done();
      };

      file.copy(newFile, { destinationKmsKeyName }, assert.ifError);
    });

    describe('destination types', () => {
      function assertPathEquals(file, expectedPath, callback) {
        file.request = reqOpts => {
          assert.strictEqual(reqOpts.uri, expectedPath);
          callback();
        };
      }

      it('should allow a string', done => {
        const newFileName = 'new-file-name.png';
        const expectedPath = `/rewriteTo/b/${
          file.bucket.name
          }/o/${newFileName}`;
        assertPathEquals(file, expectedPath, done);
        file.copy(newFileName);
      });

      it('should allow a "gs://..." string', done => {
        const newFileName = 'gs://other-bucket/new-file-name.png';
        const expectedPath = `/rewriteTo/b/other-bucket/o/new-file-name.png`;
        assertPathEquals(file, expectedPath, done);
        file.copy(newFileName);
      });

      it('should allow a Bucket', done => {
        const expectedPath = `/rewriteTo/b/${BUCKET.name}/o/${file.name}`;
        assertPathEquals(file, expectedPath, done);
        file.copy(BUCKET);
      });

      it('should allow a File', done => {
        const newFile = new File(BUCKET, 'new-file');
        const expectedPath = `/rewriteTo/b/${BUCKET.name}/o/${newFile.name}`;
        assertPathEquals(file, expectedPath, done);
        file.copy(newFile);
      });

      it('should throw if a destination cannot be parsed', () => {
        assert.throws(() => {
          file.copy(() => { });
        }, /Destination file should have a name\./);
      });
    });

    describe('not finished copying', () => {
      const apiResponse = {
        rewriteToken: '...',
      };

      beforeEach(() => {
        file.request = (reqOpts, callback) => {
          callback(null, apiResponse);
        };
      });

      it('should continue attempting to copy', done => {
        const newFile = new File(BUCKET, 'new-file');

        file.request = (reqOpts, callback) => {
          file.copy = (newFile_, options, callback) => {
            assert.strictEqual(newFile_, newFile);
            assert.deepStrictEqual(options, { token: apiResponse.rewriteToken });
            callback(); // done()
          };

          callback(null, apiResponse);
        };

        file.copy(newFile, done);
      });

      it('should pass the userProject in subsequent requests', done => {
        const newFile = new File(BUCKET, 'new-file');
        const fakeOptions = {
          userProject: 'grapce-spaceship-123',
        };

        file.request = (reqOpts, callback) => {
          file.copy = (newFile_, options) => {
            assert.notStrictEqual(options, fakeOptions);
            assert.strictEqual(options.userProject, fakeOptions.userProject);
            done();
          };

          callback(null, apiResponse);
        };

        file.copy(newFile, fakeOptions, assert.ifError);
      });

      it('should pass the KMS key name in subsequent requests', done => {
        const newFile = new File(BUCKET, 'new-file');
        const fakeOptions = {
          destinationKmsKeyName: 'kms-key-name',
        };

        file.request = (reqOpts, callback) => {
          file.copy = (newFile_, options) => {
            assert.strictEqual(
              options.destinationKmsKeyName,
              fakeOptions.destinationKmsKeyName
            );
            done();
          };

          callback(null, apiResponse);
        };

        file.copy(newFile, fakeOptions, assert.ifError);
      });

      it('should make the subsequent correct API request', done => {
        const newFile = new File(BUCKET, 'new-file');

        file.request = reqOpts => {
          assert.strictEqual(reqOpts.qs.rewriteToken, apiResponse.rewriteToken);
          done();
        };

        file.copy(newFile, { token: apiResponse.rewriteToken }, assert.ifError);
      });
    });

    describe('returned File object', () => {
      beforeEach(() => {
        const resp = { success: true };
        file.request = (reqOpts, callback) => {
          callback(null, resp);
        };
      });

      it('should re-use file object if one is provided', done => {
        const newFile = new File(BUCKET, 'new-file');
        file.copy(newFile, (err, copiedFile) => {
          assert.ifError(err);
          assert.deepStrictEqual(copiedFile, newFile);
          done();
        });
      });

      it('should create new file on the same bucket', done => {
        const newFilename = 'new-filename';
        file.copy(newFilename, (err, copiedFile) => {
          assert.ifError(err);
          assert.strictEqual(copiedFile.bucket.name, BUCKET.name);
          assert.strictEqual(copiedFile.name, newFilename);
          done();
        });
      });

      it('should create new file on the destination bucket', done => {
        file.copy(BUCKET, (err, copiedFile) => {
          assert.ifError(err);
          assert.strictEqual(copiedFile.bucket.name, BUCKET.name);
          assert.strictEqual(copiedFile.name, file.name);
          done();
        });
      });

      it('should pass apiResponse into callback', done => {
        file.copy(BUCKET, (err, copiedFile, apiResponse) => {
          assert.ifError(err);
          assert.deepStrictEqual({ success: true }, apiResponse);
          done();
        });
      });
    });
  });

  describe('createReadStream', () => {
    function getFakeRequest(data?) {
      let requestOptions;

      class FakeRequest extends stream.Readable {
        constructor(_requestOptions?) {
          super();
          requestOptions = _requestOptions;
          this._read = () => {
            if (data) {
              this.push(data);
            }
            this.push(null);
          };
        }

        static getRequestOptions() {
          return requestOptions;
        }
      }

      // Return a Proxy of FakeRequest which can be instantiated
      // without new.
      return new Proxy(FakeRequest, {
        apply(target, _, argumentsList) {
          return new target(...argumentsList);
        },
      });
    }

    function getFakeSuccessfulRequest(data) {
      // tslint:disable-next-line:variable-name
      const FakeRequest = getFakeRequest(data);

      class FakeSuccessfulRequest extends FakeRequest {
        constructor(req?) {
          super(req);

          const self = this;

          setImmediate(() => {
            const stream = new FakeRequest();
            self.emit('response', stream);
          });
        }
      }

      // Return a Proxy of FakeSuccessfulRequest which can be instantiated
      // without new.
      return new Proxy(FakeSuccessfulRequest, {
        apply(target, _, argumentsList) {
          return new target(...argumentsList);
        },
      });
    }

    function getFakeFailedRequest(error) {
      // tslint:disable-next-line:variable-name
      const FakeRequest = getFakeRequest();

      class FakeFailedRequest extends FakeRequest {
        constructor(_req?) {
          super(_req);

          const self = this;

          setImmediate(() => {
            self.emit('error', error);
          });
        }
      }

      // Return a Proxy of FakeFailedRequest which can be instantiated
      // without new.
      return new Proxy(FakeFailedRequest, {
        apply(target, _, argumentsList) {
          return new target(...argumentsList);
        },
      });
    }

    beforeEach(() => {
      handleRespOverride = (err, res, body, callback) => {
        const rawResponseStream = through();
        extend(rawResponseStream, {
          toJSON() {
            return { headers: {} };
          },
        });
        callback(null, null, rawResponseStream);
        setImmediate(() => {
          rawResponseStream.end();
        });
      };

      requestOverride = () => {
        return through();
      };
    });

    it('should throw if both a range and validation is given', () => {
      assert.throws(() => {
        file.createReadStream({
          validation: true,
          start: 3,
          end: 8,
        });
      }, /Cannot use validation with file ranges \(start\/end\)\./);

      assert.throws(() => {
        file.createReadStream({
          validation: true,
          start: 3,
        });
      }, /Cannot use validation with file ranges \(start\/end\)\./);

      assert.throws(() => {
        file.createReadStream({
          validation: true,
          end: 8,
        });
      }, /Cannot use validation with file ranges \(start\/end\)\./);

      assert.doesNotThrow(() => {
        file.createReadStream({
          start: 3,
          end: 8,
        });
      });
    });

    it('should send query.generation if File has one', done => {
      const versionedFile = new File(BUCKET, 'file.txt', { generation: 1 });

      versionedFile.requestStream = rOpts => {
        assert.strictEqual(rOpts.qs.generation, 1);
        setImmediate(done);
        return duplexify();
      };

      versionedFile.createReadStream().resume();
    });

    it('should send query.userProject if provided', done => {
      const options = {
        userProject: 'user-project-id',
      };

      file.requestStream = rOpts => {
        assert.strictEqual(rOpts.qs.userProject, options.userProject);
        setImmediate(done);
        return duplexify();
      };

      file.createReadStream(options).resume();
    });

    describe('authenticating', () => {
      it('should create an authenticated request', done => {
        file.requestStream = opts => {
          assert.deepStrictEqual(opts, {
            forever: false,
            uri: '',
            headers: {
              'Accept-Encoding': 'gzip',
            },
            qs: {
              alt: 'media',
            },
          });
          setImmediate(() => {
            done();
          });
          return duplexify();
        };

        file.createReadStream().resume();
      });

      describe('errors', () => {
        const ERROR = new Error('Error.');

        beforeEach(() => {
          file.requestStream = opts => {
            const stream = requestOverride(opts);

            setImmediate(() => {
              stream.emit('error', ERROR);
            });

            return stream;
          };
        });

        it('should emit an error from authenticating', done => {
          file
            .createReadStream()
            .once('error', err => {
              assert.strictEqual(err, ERROR);
              done();
            })
            .resume();
        });
      });
    });

    describe('requestStream', () => {
      it('should get readable stream from request', done => {
        const fakeRequest = { a: 'b', c: 'd' };

        requestOverride = getFakeRequest();

        file.requestStream = () => {
          setImmediate(() => {
            assert.deepStrictEqual(requestOverride.getRequestOptions(), fakeRequest);
            done();
          });

          return requestOverride(fakeRequest);
        };

        file.createReadStream().resume();
      });

      it('should emit response event from request', done => {
        file.requestStream = getFakeSuccessfulRequest('body');

        file
          .createReadStream({ validation: false })
          .on('response', () => {
            done();
          })
          .resume();
      });

      it('should let util.handleResp handle the response', done => {
        const response = { a: 'b', c: 'd' };

        handleRespOverride = (err, response_, body) => {
          assert.strictEqual(err, null);
          assert.strictEqual(response_, response);
          assert.strictEqual(body, null);
          done();
        };

        file.requestStream = () => {
          const stream = through();
          setImmediate(() => {
            stream.emit('response', response);
          });
          return stream;
        };

        file.createReadStream().resume();
      });

      describe('errors', () => {
        const ERROR = new Error('Error.');

        beforeEach(() => {
          file.requestStream = getFakeFailedRequest(ERROR);
        });

        it('should emit the error', done => {
          file
            .createReadStream()
            .once('error', err => {
              assert.deepStrictEqual(err, ERROR);
              done();
            })
            .resume();
        });

        it('should parse a response stream for a better error', done => {
          const rawResponsePayload = 'error message from body';
          const rawResponseStream = through();
          const requestStream = through();

          handleRespOverride = (err, res, body, callback) => {
            callback(ERROR, null, res);

            setImmediate(() => {
              rawResponseStream.end(rawResponsePayload);
            });
          };

          file.requestStream = () => {
            setImmediate(() => {
              requestStream.emit('response', rawResponseStream);
            });
            return requestStream;
          };

          file
            .createReadStream()
            .once('error', err => {
              assert.strictEqual(err, ERROR);
              assert.strictEqual(err.message, rawResponsePayload);
              done();
            })
            .resume();
        });
      });
    });

    describe('compression', () => {
      const DATA = 'test data';
      const GZIPPED_DATA = zlib.gzipSync(DATA);

      beforeEach(() => {
        handleRespOverride = (err, res, body, callback) => {
          const rawResponseStream = through();
          extend(rawResponseStream, {
            toJSON() {
              return {
                headers: {
                  'content-encoding': 'gzip',
                },
              };
            },
          });

          callback(null, null, rawResponseStream);

          setImmediate(() => {
            rawResponseStream.end(GZIPPED_DATA);
          });
        };

        file.requestStream = getFakeSuccessfulRequest(GZIPPED_DATA);
      });

      it('should gunzip the response', done => {
        file
          .createReadStream()
          .once('error', done)
          .on('data', data => {
            assert.strictEqual(data.toString(), DATA);
            done();
          })
          .resume();
      });
    });

    describe('validation', () => {
      const data = 'test';
      let fakeValidationStream;

      beforeEach(() => {
        file.metadata.mediaLink = 'http://uri';

        file.getMetadata = (options, callback) => {
          file.metadata = {
            crc32c: '####wA==',
            md5Hash: 'CY9rzUYh03PK3k6DJie09g==',
          };
          callback();
        };

        fakeValidationStream = through();
        fakeValidationStream.test = () => {
          return true;
        };
        hashStreamValidationOverride = () => {
          return fakeValidationStream;
        };
      });

      it('should pass the userProject to getMetadata', done => {
        const fakeOptions = {
          userProject: 'grapce-spaceship-123',
        };

        file.getMetadata = options => {
          assert.strictEqual(options.userProject, fakeOptions.userProject);
          done();
        };

        file.requestStream = getFakeSuccessfulRequest(data);

        file
          .createReadStream(fakeOptions)
          .on('error', done)
          .resume();
      });

      it('should destroy stream from failed metadata fetch', done => {
        const error = new Error('Error.');
        file.getMetadata = (options, callback) => {
          callback(error);
        };

        file.requestStream = getFakeSuccessfulRequest('data');

        file
          .createReadStream()
          .on('error', err => {
            assert.strictEqual(err, error);
            done();
          })
          .resume();
      });

      it('should validate with crc32c', done => {
        file.requestStream = getFakeSuccessfulRequest(data);

        file
          .createReadStream({ validation: 'crc32c' })
          .on('error', done)
          .on('end', done)
          .resume();
      });

      it('should emit an error if crc32c validation fails', done => {
        file.requestStream = getFakeSuccessfulRequest('bad-data');

        fakeValidationStream.test = () => {
          return false;
        };

        file
          .createReadStream({ validation: 'crc32c' })
          .on('error', err => {
            assert.strictEqual(err.code, 'CONTENT_DOWNLOAD_MISMATCH');
            done();
          })
          .resume();
      });

      it('should validate with md5', done => {
        file.requestStream = getFakeSuccessfulRequest(data);

        fakeValidationStream.test = () => {
          return true;
        };

        file
          .createReadStream({ validation: 'md5' })
          .on('error', done)
          .on('end', done)
          .resume();
      });

      it('should emit an error if md5 validation fails', done => {
        file.requestStream = getFakeSuccessfulRequest('bad-data');

        fakeValidationStream.test = () => {
          return false;
        };

        file
          .createReadStream({ validation: 'md5' })
          .on('error', err => {
            assert.strictEqual(err.code, 'CONTENT_DOWNLOAD_MISMATCH');
            done();
          })
          .resume();
      });

      it('should default to crc32c validation', done => {
        file.getMetadata = (options, callback) => {
          file.metadata = {
            crc32c: file.metadata.crc32c,
          };
          callback();
        };

        file.requestStream = getFakeSuccessfulRequest(data);

        file
          .createReadStream()
          .on('error', err => {
            assert.strictEqual(err.code, 'CONTENT_DOWNLOAD_MISMATCH');
            done();
          })
          .resume();
      });

      it('should ignore a data mismatch if validation: false', done => {
        file.requestStream = getFakeSuccessfulRequest(data);

        fakeValidationStream.test = () => {
          return false;
        };

        file
          .createReadStream({ validation: false })
          .resume()
          .on('error', done)
          .on('end', done);
      });

      describe('destroying the through stream', () => {
        beforeEach(() => {
          fakeValidationStream.test = () => {
            return false;
          };
        });

        it('should destroy after failed validation', done => {
          file.requestStream = getFakeSuccessfulRequest('bad-data');

          const readStream = file.createReadStream({ validation: 'md5' });
          readStream.destroy = err => {
            assert.strictEqual(err.code, 'CONTENT_DOWNLOAD_MISMATCH');
            done();
          };
          readStream.resume();
        });

        it('should destroy if MD5 is requested but absent', done => {
          file.getMetadata = (options, callback) => {
            file.metadata = {
              crc32c: file.metadata.crc32c,
            };
            callback();
          };

          file.requestStream = getFakeSuccessfulRequest('bad-data');

          const readStream = file.createReadStream({ validation: 'md5' });
          readStream.destroy = err => {
            assert.strictEqual(err.code, 'MD5_NOT_AVAILABLE');
            done();
          };
          readStream.resume();
        });
      });
    });

    describe('range requests', () => {
      it('should accept a start range', done => {
        const startOffset = 100;

        file.requestStream = opts => {
          setImmediate(() => {
            assert.strictEqual(opts.headers.Range, 'bytes=' + startOffset + '-');
            done();
          });
          return duplexify();
        };

        file.createReadStream({ start: startOffset }).resume();
      });

      it('should accept an end range and set start to 0', done => {
        const endOffset = 100;

        file.requestStream = opts => {
          setImmediate(() => {
            assert.strictEqual(opts.headers.Range, 'bytes=0-' + endOffset);
            done();
          });
          return duplexify();
        };

        file.createReadStream({ end: endOffset }).resume();
      });

      it('should accept both a start and end range', done => {
        const startOffset = 100;
        const endOffset = 101;

        file.requestStream = opts => {
          setImmediate(() => {
            const expectedRange = 'bytes=' + startOffset + '-' + endOffset;
            assert.strictEqual(opts.headers.Range, expectedRange);
            done();
          });
          return duplexify();
        };

        file.createReadStream({ start: startOffset, end: endOffset }).resume();
      });

      it('should accept range start and end as 0', done => {
        const startOffset = 0;
        const endOffset = 0;

        file.requestStream = opts => {
          setImmediate(() => {
            const expectedRange = 'bytes=0-0';
            assert.strictEqual(opts.headers.Range, expectedRange);
            done();
          });
          return duplexify();
        };

        file.createReadStream({ start: startOffset, end: endOffset }).resume();
      });

      it('should end the through stream', done => {
        file.requestStream = getFakeSuccessfulRequest('body');

        const readStream = file.createReadStream({ start: 100 });
        readStream.end = done;
        readStream.resume();
      });
    });

    describe('tail requests', () => {
      it('should make a request for the tail bytes', done => {
        const endOffset = -10;

        file.requestStream = opts => {
          setImmediate(() => {
            assert.strictEqual(opts.headers.Range, 'bytes=' + endOffset);
            done();
          });
          return duplexify();
        };

        file.createReadStream({ end: endOffset }).resume();
      });
    });
  });

  describe('createResumableUpload', () => {
    it('should not require options', done => {
      resumableUploadOverride = {
        createURI(opts, callback) {
          assert.strictEqual(opts.metadata, undefined);
          callback();
        },
      };

      file.createResumableUpload(done);
    });

    it('should create a resumable upload URI', done => {
      const options = {
        metadata: {
          contentType: 'application/json',
        },
        origin: '*',
        predefinedAcl: 'predefined-acl',
        private: 'private',
        public: 'public',
        userProject: 'user-project-id',
      };

      file.generation = 3;
      file.encryptionKey = 'encryption-key';
      file.kmsKeyName = 'kms-key-name';

      resumableUploadOverride = {
        createURI(opts, callback) {
          const bucket = file.bucket;
          const storage = bucket.storage;

          assert.strictEqual(opts.authClient, storage.authClient);
          assert.strictEqual(opts.bucket, bucket.name);
          assert.strictEqual(opts.file, file.name);
          assert.strictEqual(opts.generation, file.generation);
          assert.strictEqual(opts.key, file.encryptionKey);
          assert.strictEqual(opts.kmsKeyName, file.kmsKeyName);
          assert.strictEqual(opts.metadata, options.metadata);
          assert.strictEqual(opts.origin, options.origin);
          assert.strictEqual(opts.predefinedAcl, options.predefinedAcl);
          assert.strictEqual(opts.private, options.private);
          assert.strictEqual(opts.public, options.public);
          assert.strictEqual(opts.userProject, options.userProject);

          callback();
        },
      };

      file.createResumableUpload(options, done);
    });
  });

  describe('createWriteStream', () => {
    const METADATA = { a: 'b', c: 'd' };

    beforeEach(() => {
      extend(fakeFs, {
        access(dir, check, callback) {
          // Assume that the required config directory is writable.
          callback();
        },
      });
    });

    it('should return a stream', () => {
      assert(file.createWriteStream() instanceof stream);
    });

    it('should emit errors', done => {
      const error = new Error('Error.');
      const uploadStream = new stream.PassThrough();

      file.startResumableUpload_ = dup => {
        dup.setWritable(uploadStream);
        uploadStream.emit('error', error);
      };

      const writable = file.createWriteStream();

      writable.on('error', err => {
        assert.strictEqual(err, error);
        done();
      });

      writable.write('data');
    });

    it('should start a simple upload if specified', done => {
      const options = {
        metadata: METADATA,
        resumable: false,
        customValue: true,
      };
      const writable = file.createWriteStream(options);

      file.startSimpleUpload_ = (stream, options_) => {
        assert.deepStrictEqual(options_, options);
        done();
      };

      writable.write('data');
    });

    it('should start a resumable upload if specified', done => {
      const options = {
        metadata: METADATA,
        resumable: true,
        customValue: true,
      };
      const writable = file.createWriteStream(options);

      file.startResumableUpload_ = (stream, options_) => {
        assert.deepStrictEqual(options_, options);
        done();
      };

      writable.write('data');
    });

    it('should check if xdg-basedir is writable', done => {
      const fakeDir = 'fake-xdg-dir';

      xdgConfigOverride = fakeDir;

      extend(fakeFs, {
        access(dir) {
          assert.strictEqual(dir, fakeDir);
          done();
        },
      });

      file.createWriteStream({ resumable: true }).write('data');
    });

    it('should fall back to checking tmpdir', done => {
      const fakeDir = 'fake-tmp-dir';

      xdgConfigOverride = false;

      fakeOs.tmpdir = () => {
        return fakeDir;
      };

      extend(fakeFs, {
        access(dir) {
          assert.strictEqual(dir, fakeDir);
          done();
        },
      });

      file.createWriteStream({ resumable: true }).write('data');
    });

    it('should fail if resumable requested but not writable', done => {
      const error = new Error('Error.');

      extend(fakeFs, {
        access(dir, check, callback) {
          callback(error);
        },
      });

      const writable = file.createWriteStream({ resumable: true });

      writable.on('error', err => {
        assert.notStrictEqual(err, error);

        assert.strictEqual(err.name, 'ResumableUploadError');

        const configDir = xdgBasedirCached.config;

        assert.strictEqual(
          err.message,
          [
            'A resumable upload could not be performed. The directory,',
            `${configDir}, is not writable. You may try another upload,`,
            'this time setting `options.resumable` to `false`.',
          ].join(' ')
        );

        done();
      });

      writable.write('data');
    });

    it('should fall back to simple if not writable', done => {
      const options = {
        metadata: METADATA,
        customValue: true,
      };

      file.startSimpleUpload_ = (stream, options_) => {
        assert.deepStrictEqual(options_, options);
        done();
      };

      extend(fakeFs, {
        access(dir, check, callback) {
          callback(new Error('Error.'));
        },
      });

      file.createWriteStream(options).write('data');
    });

    it('should default to a resumable upload', done => {
      const writable = file.createWriteStream({
        metadata: METADATA,
      });

      file.startResumableUpload_ = (stream, options) => {
        assert.deepStrictEqual(options.metadata, METADATA);
        done();
      };

      writable.write('data');
    });

    it('should alias contentType to metadata object', done => {
      const contentType = 'text/html';
      const writable = file.createWriteStream({ contentType });

      file.startResumableUpload_ = (stream, options) => {
        assert.strictEqual(options.metadata.contentType, contentType);
        done();
      };

      writable.write('data');
    });

    it('should detect contentType with contentType:auto', done => {
      const writable = file.createWriteStream({ contentType: 'auto' });

      file.startResumableUpload_ = (stream, options) => {
        assert.strictEqual(options.metadata.contentType, 'image/png');
        done();
      };

      writable.write('data');
    });

    it('should set encoding with gzip:true', done => {
      const writable = file.createWriteStream({ gzip: true });

      file.startResumableUpload_ = (stream, options) => {
        assert.strictEqual(options.metadata.contentEncoding, 'gzip');
        done();
      };

      writable.write('data');
    });

    it('should set encoding with gzip:auto & compressible', done => {
      const writable = file.createWriteStream({
        gzip: 'auto',
        contentType: 'text/html', // (compressible)
      });

      file.startResumableUpload_ = (stream, options) => {
        assert.strictEqual(options.metadata.contentEncoding, 'gzip');
        done();
      };

      writable.write('data');
    });

    it('should not set encoding with gzip:auto & non-compressible', done => {
      const writable = file.createWriteStream({ gzip: 'auto' });

      file.startResumableUpload_ = (stream, options) => {
        assert.strictEqual(options.metadata.contentEncoding, undefined);
        done();
      };

      writable.write('data');
    });

    it('should re-emit response event', done => {
      const writable = file.createWriteStream();
      const resp = {};

      file.startResumableUpload_ = stream => {
        stream.emit('response', resp);
      };

      writable.on('response', resp_ => {
        assert.strictEqual(resp_, resp);
        done();
      });

      writable.write('data');
    });

    it('should cork data on prefinish', done => {
      const writable = file.createWriteStream({ resumable: false });

      file.startSimpleUpload_ = stream => {
        assert.strictEqual(writable._corked, 0);
        stream.emit('prefinish');
        assert.strictEqual(writable._corked, 1);
        done();
      };

      writable.end('data');
    });

    describe('validation', () => {
      const data = 'test';

      const fakeMetadata = {
        crc32c: { crc32c: '####wA==' },
        md5: { md5Hash: 'CY9rzUYh03PK3k6DJie09g==' },
      };

      it('should uncork after successful write', done => {
        const writable = file.createWriteStream({ validation: 'crc32c' });

        file.startResumableUpload_ = stream => {
          setImmediate(() => {
            assert.strictEqual(writable._corked, 1);

            file.metadata = fakeMetadata.crc32c;
            stream.emit('complete');

            assert.strictEqual(writable._corked, 0);
            done();
          });
        };

        writable.end(data);

        writable.on('error', done);
      });

      it('should validate with crc32c', done => {
        const writable = file.createWriteStream({ validation: 'crc32c' });

        file.startResumableUpload_ = stream => {
          setImmediate(() => {
            file.metadata = fakeMetadata.crc32c;
            stream.emit('complete');
          });
        };

        writable.end(data);

        writable.on('error', done).on('finish', done);
      });

      it('should emit an error if crc32c validation fails', done => {
        const writable = file.createWriteStream({ validation: 'crc32c' });

        file.startResumableUpload_ = stream => {
          setImmediate(() => {
            file.metadata = fakeMetadata.crc32c;
            stream.emit('complete');
          });
        };

        file.delete = cb => {
          cb();
        };

        writable.write('bad-data');
        writable.end();

        writable.on('error', err => {
          assert.strictEqual(err.code, 'FILE_NO_UPLOAD');
          done();
        });
      });

      it('should validate with md5', done => {
        const writable = file.createWriteStream({ validation: 'md5' });

        file.startResumableUpload_ = stream => {
          setImmediate(() => {
            file.metadata = fakeMetadata.md5;
            stream.emit('complete');
          });
        };

        writable.write(data);
        writable.end();

        writable.on('error', done).on('finish', done);
      });

      it('should emit an error if md5 validation fails', done => {
        const writable = file.createWriteStream({ validation: 'md5' });

        file.startResumableUpload_ = stream => {
          setImmediate(() => {
            file.metadata = fakeMetadata.md5;
            stream.emit('complete');
          });
        };

        file.delete = cb => {
          cb();
        };

        writable.write('bad-data');
        writable.end();

        writable.on('error', err => {
          assert.strictEqual(err.code, 'FILE_NO_UPLOAD');
          done();
        });
      });

      it('should default to md5 validation', done => {
        const writable = file.createWriteStream();

        file.startResumableUpload_ = stream => {
          setImmediate(() => {
            file.metadata = { md5Hash: 'bad-hash' };
            stream.emit('complete');
          });
        };

        file.delete = cb => {
          cb();
        };

        writable.write(data);
        writable.end();

        writable.on('error', err => {
          assert.strictEqual(err.code, 'FILE_NO_UPLOAD');
          done();
        });
      });

      it('should ignore a data mismatch if validation: false', done => {
        const writable = file.createWriteStream({ validation: false });

        file.startResumableUpload_ = stream => {
          setImmediate(() => {
            file.metadata = { md5Hash: 'bad-hash' };
            stream.emit('complete');
          });
        };

        writable.write(data);
        writable.end();

        writable.on('error', done);
        writable.on('finish', done);
      });

      it('should delete the file if validation fails', done => {
        const writable = file.createWriteStream();

        file.startResumableUpload_ = stream => {
          setImmediate(() => {
            file.metadata = { md5Hash: 'bad-hash' };
            stream.emit('complete');
          });
        };

        file.delete = () => {
          done();
        };

        writable.write(data);
        writable.end();
      });

      it('should emit an error if MD5 is requested but absent', done => {
        const writable = file.createWriteStream({ validation: 'md5' });

        file.startResumableUpload_ = stream => {
          setImmediate(() => {
            file.metadata = { crc32c: 'not-md5' };
            stream.emit('complete');
          });
        };

        file.delete = cb => {
          cb();
        };

        writable.write(data);
        writable.end();

        writable.on('error', err => {
          assert.strictEqual(err.code, 'MD5_NOT_AVAILABLE');
          done();
        });
      });

      it('should emit a different error if delete fails', done => {
        const writable = file.createWriteStream();

        file.startResumableUpload_ = stream => {
          setImmediate(() => {
            file.metadata = { md5Hash: 'bad-hash' };
            stream.emit('complete');
          });
        };

        const deleteErrorMessage = 'Delete error message.';
        const deleteError = new Error(deleteErrorMessage);
        file.delete = cb => {
          cb(deleteError);
        };

        writable.write(data);
        writable.end();

        writable.on('error', err => {
          assert.strictEqual(err.code, 'FILE_NO_UPLOAD_DELETE');
          assert(err.message.indexOf(deleteErrorMessage) > -1);
          done();
        });
      });
    });
  });

  describe('delete', () => {
    it('should make the correct request', done => {
      extend(file.parent, {
        delete(options, callback) {
          assert.strictEqual(this, file);
          assert.deepStrictEqual(options, {});
          callback(); // done()
        },
      });

      file.delete(done);
    });

    it('should accept options', done => {
      const options = {
        a: 'b',
        c: 'd',
      };

      file.parent.delete = options_ => {
        assert.deepStrictEqual(options_, options);
        done();
      };

      file.delete(options, assert.ifError);
    });

    it('should use requestQueryObject', done => {
      const options = {
        a: 'b',
        c: 'd',
      };

      file.requestQueryObject = {
        generation: 2,
      };

      const expectedOptions = {
        a: 'b',
        c: 'd',
        generation: 2,
      };

      file.parent.delete = options => {
        assert.deepStrictEqual(options, expectedOptions);
        done();
      };

      file.delete(options, assert.ifError);
    });
  });

  describe('download', () => {
    let fileReadStream;

    beforeEach(() => {
      fileReadStream = new stream.Readable();
      fileReadStream._read = util.noop;

      fileReadStream.on('end', () => {
        fileReadStream.emit('complete');
      });

      file.createReadStream = () => {
        return fileReadStream;
      };
    });

    it('should accept just a callback', done => {
      fileReadStream._read = () => {
        done();
      };

      file.download(assert.ifError);
    });

    it('should accept an options object and callback', done => {
      fileReadStream._read = () => {
        done();
      };

      file.download({}, assert.ifError);
    });

    it('should pass the provided options to createReadStream', done => {
      const readOptions = { start: 100, end: 200 };

      file.createReadStream = options => {
        assert.deepStrictEqual(options, readOptions);
        done();
        return fileReadStream;
      };

      file.download(readOptions, assert.ifError);
    });

    it('should only execute callback once', done => {
      extend(fileReadStream, {
        _read() {
          this.emit('error', new Error('Error.'));
          this.emit('error', new Error('Error.'));
        },
      });

      file.download(() => {
        done();
      });
    });

    describe('into memory', () => {
      it('should buffer a file into memory if no destination', done => {
        const fileContents = 'abcdefghijklmnopqrstuvwxyz';

        extend(fileReadStream, {
          _read() {
            this.push(fileContents);
            this.push(null);
          },
        });

        file.download((err, remoteFileContents) => {
          assert.ifError(err);

          assert.strictEqual(fileContents, remoteFileContents.toString());
          done();
        });
      });

      it('should execute callback with error', done => {
        const error = new Error('Error.');

        extend(fileReadStream, {
          _read() {
            this.emit('error', error);
          }
        });

        file.download(err => {
          assert.strictEqual(err, error);
          done();
        });
      });
    });

    describe('with destination', () => {
      it('should write the file to a destination if provided', done => {
        tmp.setGracefulCleanup();
        tmp.file(function _tempFileCreated(err, tmpFilePath) {
          assert.ifError(err);

          const fileContents = 'abcdefghijklmnopqrstuvwxyz';

          extend(fileReadStream, {
            _read() {
              this.push(fileContents);
              this.push(null);
            },
          });

          file.download({ destination: tmpFilePath }, err => {
            assert.ifError(err);

            fs.readFile(tmpFilePath, (err, tmpFileContents) => {
              assert.ifError(err);

              assert.strictEqual(fileContents, tmpFileContents.toString());
              done();
            });
          });
        });
      });

      it('should execute callback with error', done => {
        tmp.setGracefulCleanup();
        tmp.file(function _tempFileCreated(err, tmpFilePath) {
          assert.ifError(err);

          const error = new Error('Error.');

          extend(fileReadStream, {
            _read() {
              this.emit('error', error);
            },
          });

          file.download({ destination: tmpFilePath }, err => {
            assert.strictEqual(err, error);
            done();
          });
        });
      });
    });
  });

  describe('exists', () => {
    it('should call parent exists function', done => {
      const options = {};

      file.parent.exists = (options_, callback) => {
        assert.strictEqual(options_, options);
        callback(); // done()
      };

      file.exists(options, done);
    });
  });

  describe('get', () => {
    it('should call parent get function', done => {
      const options = {};

      file.parent.get = (options_, callback) => {
        assert.strictEqual(options_, options);
        callback(); // done()
      };

      file.get(options, done);
    });
  });

  describe('getMetadata', () => {
    it('should make the correct request', done => {
      extend(file.parent, {
        getMetadata(options, callback) {
          assert.strictEqual(this, file);
          assert.deepStrictEqual(options, {});
          callback(); // done()
        },
      });

      file.getMetadata(done);
    });

    it('should accept options', done => {
      const options = {
        a: 'b',
        c: 'd',
      };

      file.parent.getMetadata = options_ => {
        assert.deepStrictEqual(options_, options);
        done();
      };

      file.getMetadata(options, assert.ifError);
    });

    it('should use requestQueryObject', done => {
      const options = {
        a: 'b',
        c: 'd',
      };

      file.requestQueryObject = {
        generation: 2,
      };

      const expectedOptions = {
        a: 'b',
        c: 'd',
        generation: 2,
      };

      file.parent.getMetadata = options => {
        assert.deepStrictEqual(options, expectedOptions);
        done();
      };

      file.getMetadata(options, assert.ifError);
    });
  });

  describe('getSignedPolicy', () => {
    const CONFIG = {
      expires: Date.now() + 2000,
    };

    beforeEach(() => {
      BUCKET.storage.authClient = {
        sign: () => {
          return Promise.resolve('signature');
        },
      };
    });

    it('should create a signed policy', done => {
      BUCKET.storage.authClient.sign = blobToSign => {
        const policy = Buffer.from(blobToSign, 'base64').toString();
        assert.strictEqual(typeof JSON.parse(policy), 'object');
        return Promise.resolve('signature');
      };

      file.getSignedPolicy(CONFIG, (err, signedPolicy) => {
        assert.ifError(err);
        assert.strictEqual(typeof signedPolicy.string, 'string');
        assert.strictEqual(typeof signedPolicy.base64, 'string');
        assert.strictEqual(typeof signedPolicy.signature, 'string');
        done();
      });
    });

    it('should not modify the configuration object', done => {
      const originalConfig = extend({}, CONFIG);

      file.getSignedPolicy(CONFIG, err => {
        assert.ifError(err);
        assert.deepStrictEqual(CONFIG, originalConfig);
        done();
      });
    });

    it('should return an error if signBlob errors', done => {
      const error = new Error('Error.');

      BUCKET.storage.authClient.sign = () => {
        return Promise.reject(error);
      };

      file.getSignedPolicy(CONFIG, err => {
        assert.strictEqual(err.name, 'SigningError');
        assert.strictEqual(err.message, error.message);
        done();
      });
    });

    it('should add key equality condition', done => {
      file.getSignedPolicy(CONFIG, (err, signedPolicy) => {
        const conditionString = '["eq","$key","' + file.name + '"]';
        assert.ifError(err);
        assert(signedPolicy.string.indexOf(conditionString) > -1);
        done();
      });
    });

    it('should add ACL condtion', done => {
      file.getSignedPolicy(
        {
          expires: Date.now() + 2000,
          acl: '<acl>',
        },
        (err, signedPolicy) => {
          const conditionString = '{"acl":"<acl>"}';
          assert.ifError(err);
          assert(signedPolicy.string.indexOf(conditionString) > -1);
          done();
        }
      );
    });

    it('should add success redirect', done => {
      const redirectUrl = 'http://redirect';

      file.getSignedPolicy(
        {
          expires: Date.now() + 2000,
          successRedirect: redirectUrl,
        },
        (err, signedPolicy) => {
          assert.ifError(err);

          const policy = JSON.parse(signedPolicy.string);
          assert(
            policy.conditions.some(condition => {
              return condition.success_action_redirect === redirectUrl;
            })
          );

          done();
        }
      );
    });

    it('should add success status', done => {
      const successStatus = '200';

      file.getSignedPolicy(
        {
          expires: Date.now() + 2000,
          successStatus,
        },
        (err, signedPolicy) => {
          assert.ifError(err);

          const policy = JSON.parse(signedPolicy.string);
          assert(
            policy.conditions.some(condition => {
              return condition.success_action_status === successStatus;
            })
          );

          done();
        }
      );
    });

    describe('expires', () => {
      it('should accept Date objects', done => {
        const expires = new Date(Date.now() + 1000 * 60);

        file.getSignedPolicy(
          {
            expires,
          },
          (err, policy) => {
            assert.ifError(err);
            const expires_ = JSON.parse(policy.string).expiration;
            assert.strictEqual(expires_, expires.toISOString());
            done();
          }
        );
      });

      it('should accept numbers', done => {
        const expires = Date.now() + 1000 * 60;

        file.getSignedPolicy(
          {
            expires,
          },
          (err, policy) => {
            assert.ifError(err);
            const expires_ = JSON.parse(policy.string).expiration;
            assert.strictEqual(expires_, new Date(expires).toISOString());
            done();
          }
        );
      });

      it('should accept strings', done => {
        const expires = '12-12-2099';

        file.getSignedPolicy(
          {
            expires,
          },
          (err, policy) => {
            assert.ifError(err);
            const expires_ = JSON.parse(policy.string).expiration;
            assert.strictEqual(expires_, new Date(expires).toISOString());
            done();
          }
        );
      });

      it('should throw if a date from the past is given', () => {
        const expires = Date.now() - 5;

        assert.throws(() => {
          file.getSignedPolicy(
            {
              expires,
            },
            () => { }
          );
        }, /An expiration date cannot be in the past\./);
      });
    });

    describe('equality condition', () => {
      it('should add equality conditions (array of arrays)', done => {
        file.getSignedPolicy(
          {
            expires: Date.now() + 2000,
            equals: [['$<field>', '<value>']],
          },
          (err, signedPolicy) => {
            const conditionString = '["eq","$<field>","<value>"]';
            assert.ifError(err);
            assert(signedPolicy.string.indexOf(conditionString) > -1);
            done();
          }
        );
      });

      it('should add equality condition (array)', done => {
        file.getSignedPolicy(
          {
            expires: Date.now() + 2000,
            equals: ['$<field>', '<value>'],
          },
          (err, signedPolicy) => {
            const conditionString = '["eq","$<field>","<value>"]';
            assert.ifError(err);
            assert(signedPolicy.string.indexOf(conditionString) > -1);
            done();
          }
        );
      });

      it('should throw if equal condition is not an array', () => {
        assert.throws(() => {
          file.getSignedPolicy(
            {
              expires: Date.now() + 2000,
              equals: [{}],
            },
            () => { }
          );
        }, /Equals condition must be an array of 2 elements\./);
      });

      it('should throw if equal condition length is not 2', () => {
        assert.throws(() => {
          file.getSignedPolicy(
            {
              expires: Date.now() + 2000,
              equals: [['1', '2', '3']],
            },
            () => { }
          );
        }, /Equals condition must be an array of 2 elements\./);
      });
    });

    describe('prefix conditions', () => {
      it('should add prefix conditions (array of arrays)', done => {
        file.getSignedPolicy(
          {
            expires: Date.now() + 2000,
            startsWith: [['$<field>', '<value>']],
          },
          (err, signedPolicy) => {
            const conditionString = '["starts-with","$<field>","<value>"]';
            assert.ifError(err);
            assert(signedPolicy.string.indexOf(conditionString) > -1);
            done();
          }
        );
      });

      it('should add prefix condition (array)', done => {
        file.getSignedPolicy(
          {
            expires: Date.now() + 2000,
            startsWith: ['$<field>', '<value>'],
          },
          (err, signedPolicy) => {
            const conditionString = '["starts-with","$<field>","<value>"]';
            assert.ifError(err);
            assert(signedPolicy.string.indexOf(conditionString) > -1);
            done();
          }
        );
      });

      it('should throw if prexif condition is not an array', () => {
        assert.throws(() => {
          file.getSignedPolicy(
            {
              expires: Date.now() + 2000,
              startsWith: [{}],
            },
            () => { }
          );
        }, /StartsWith condition must be an array of 2 elements\./);
      });

      it('should throw if prefix condition length is not 2', () => {
        assert.throws(() => {
          file.getSignedPolicy(
            {
              expires: Date.now() + 2000,
              startsWith: [['1', '2', '3']],
            },
            () => { }
          );
        }, /StartsWith condition must be an array of 2 elements\./);
      });
    });

    describe('content length', () => {
      it('should add content length condition', done => {
        file.getSignedPolicy(
          {
            expires: Date.now() + 2000,
            contentLengthRange: { min: 0, max: 1 },
          },
          (err, signedPolicy) => {
            const conditionString = '["content-length-range",0,1]';
            assert.ifError(err);
            assert(signedPolicy.string.indexOf(conditionString) > -1);
            done();
          }
        );
      });

      it('should throw if content length has no min', () => {
        assert.throws(() => {
          file.getSignedPolicy(
            {
              expires: Date.now() + 2000,
              contentLengthRange: [{ max: 1 }],
            },
            () => { }
          );
        }, /ContentLengthRange must have numeric min & max fields\./);
      });

      it('should throw if content length has no max', () => {
        assert.throws(() => {
          file.getSignedPolicy(
            {
              expires: Date.now() + 2000,
              contentLengthRange: [{ min: 0 }],
            },
            () => { }
          );
        }, /ContentLengthRange must have numeric min & max fields\./);
      });
    });
  });

  describe('getSignedUrl', () => {
    const CONFIG = {
      action: 'read',
      expires: Date.now() + 2000,
    };

    beforeEach(() => {
      BUCKET.storage.authClient = {
        getCredentials() {
          return Promise.resolve({
            client_email: 'client-email',
          });
        },
        sign() {
          return Promise.resolve('signature');
        },
      };
    });

    it('should create a signed url', done => {
      BUCKET.storage.authClient.sign = blobToSign => {
        assert.deepStrictEqual(
          blobToSign,
          [
            'GET',
            '',
            '',
            Math.round(CONFIG.expires / 1000),
            `/${BUCKET.name}/${encodeURIComponent(file.name)}`,
          ].join('\n')
        );
        return Promise.resolve('signature');
      };

      file.getSignedUrl(CONFIG, (err, signedUrl) => {
        assert.ifError(err);
        assert.strictEqual(typeof signedUrl, 'string');
        const expires = Math.round(CONFIG.expires / 1000);
        const expected =
          'https://storage.googleapis.com/bucket-name/file-name.png?' +
          'GoogleAccessId=client-email&Expires=' +
          expires +
          '&Signature=signature';
        assert.strictEqual(signedUrl, expected);
        done();
      });
    });

    it('should not modify the configuration object', done => {
      const originalConfig = extend({}, CONFIG);

      file.getSignedUrl(CONFIG, err => {
        assert.ifError(err);
        assert.deepStrictEqual(CONFIG, originalConfig);
        done();
      });
    });

    it('should set correct settings if resumable', done => {
      const config = extend({}, CONFIG, {
        action: 'resumable',
      });

      BUCKET.storage.authClient.sign = blobToSign => {
        assert.strictEqual(blobToSign.indexOf('POST'), 0);
        assert(blobToSign.indexOf('x-goog-resumable:start') > -1);
        done();
      };

      file.getSignedUrl(config, assert.ifError);
    });

    it('should return an error if signBlob errors', done => {
      const error = new Error('Error.');

      BUCKET.storage.authClient.sign = () => {
        return Promise.reject(error);
      };

      file.getSignedUrl(CONFIG, err => {
        assert.strictEqual(err.name, 'SigningError');
        assert.strictEqual(err.message, error.message);
        done();
      });
    });

    it('should URI encode file names', done => {
      directoryFile.getSignedUrl(CONFIG, (err, signedUrl) => {
        assert(signedUrl.indexOf(encodeURIComponent(directoryFile.name)) > -1);
        done();
      });
    });

    it('should add response-content-type parameter', done => {
      const type = 'application/json';

      directoryFile.getSignedUrl(
        {
          action: 'read',
          expires: Date.now() + 2000,
          responseType: type,
        },
        (err, signedUrl) => {
          assert(signedUrl.indexOf(encodeURIComponent(type)) > -1);
          done();
        }
      );
    });

    it('should add generation parameter', done => {
      const generation = 10003320000;
      const file = new File(BUCKET, 'name', { generation });

      file.getSignedUrl(CONFIG, (err, signedUrl) => {
        assert(signedUrl.indexOf(encodeURIComponent(generation.toString())) > -1);
        done();
      });
    });

    describe('cname', () => {
      it('should use a provided cname', done => {
        const host = 'http://www.example.com';
        const configWithCname = extend({ cname: host }, CONFIG);

        file.getSignedUrl(configWithCname, (err, signedUrl) => {
          assert.ifError(err);

          const expires = Math.round(CONFIG.expires / 1000);
          const expected =
            'http://www.example.com/file-name.png?' +
            'GoogleAccessId=client-email&Expires=' +
            expires +
            '&Signature=signature';

          assert.strictEqual(signedUrl, expected);
          done();
        });
      });

      it('should remove trailing slashes from cname', done => {
        const host = 'http://www.example.com//';

        file.getSignedUrl(
          {
            action: 'read',
            cname: host,
            expires: Date.now() + 2000,
          },
          (err, signedUrl) => {
            assert.ifError(err);
            assert.strictEqual(signedUrl.indexOf(host), -1);
            assert.strictEqual(signedUrl.indexOf(host.substr(0, -1)), 0);
            done();
          }
        );
      });
    });

    describe('promptSaveAs', () => {
      it('should add response-content-disposition', done => {
        const disposition = 'attachment; filename="fname.ext"';
        directoryFile.getSignedUrl(
          {
            action: 'read',
            expires: Date.now() + 2000,
            promptSaveAs: 'fname.ext',
          },
          (err, signedUrl) => {
            assert(signedUrl.indexOf(encodeURIComponent(disposition)) > -1);
            done();
          }
        );
      });
    });

    describe('responseDisposition', () => {
      it('should add response-content-disposition', done => {
        const disposition = 'attachment; filename="fname.ext"';
        directoryFile.getSignedUrl(
          {
            action: 'read',
            expires: Date.now() + 2000,
            responseDisposition: disposition,
          },
          (err, signedUrl) => {
            assert(signedUrl.indexOf(encodeURIComponent(disposition)) > -1);
            done();
          }
        );
      });

      it('should ignore promptSaveAs if set', done => {
        const disposition = 'attachment; filename="fname.ext"';
        const saveAs = 'fname2.ext';
        directoryFile.getSignedUrl(
          {
            action: 'read',
            expires: Date.now() + 2000,
            promptSaveAs: saveAs,
            responseDisposition: disposition,
          },
          (err, signedUrl) => {
            assert(signedUrl.indexOf(encodeURIComponent(disposition)) > -1);
            assert(signedUrl.indexOf(encodeURIComponent(saveAs)) === -1);
            done();
          }
        );
      });
    });

    describe('expires', () => {
      it('should accept Date objects', done => {
        const expires = new Date(Date.now() + 1000 * 60);
        const expectedExpires = Math.round(expires.valueOf() / 1000);

        file.getSignedUrl(
          {
            action: 'read',
            expires,
          },
          (err, signedUrl) => {
            assert.ifError(err);
            const expires_ = url.parse(signedUrl, true).query.Expires;
            assert.strictEqual(expires_, expectedExpires.toString());
            done();
          }
        );
      });

      it('should accept numbers', done => {
        const expires = Date.now() + 1000 * 60;
        const expectedExpires = Math.round(new Date(expires).valueOf() / 1000);

        file.getSignedUrl(
          {
            action: 'read',
            expires,
          },
          (err, signedUrl) => {
            assert.ifError(err);
            const expires_ = url.parse(signedUrl, true).query.Expires;
            assert.strictEqual(expires_, expectedExpires.toString());
            done();
          }
        );
      });

      it('should accept strings', done => {
        const expires = '12-12-2099';
        const expectedExpires = Math.round(new Date(expires).valueOf() / 1000);

        file.getSignedUrl(
          {
            action: 'read',
            expires,
          },
          (err, signedUrl) => {
            assert.ifError(err);
            const expires_ = url.parse(signedUrl, true).query.Expires;
            assert.strictEqual(expires_, expectedExpires.toString());
            done();
          }
        );
      });

      it('should throw if a date from the past is given', () => {
        const expires = Date.now() - 5;

        assert.throws(() => {
          file.getSignedUrl(
            {
              action: 'read',
              expires,
            },
            () => { }
          );
        }, /An expiration date cannot be in the past\./);
      });
    });

    describe('extensionHeaders', () => {
      it('should add headers to signature', done => {
        const extensionHeaders = {
          'x-goog-acl': 'public-read',
          'x-foo': 'bar',
        };

        BUCKET.storage.authClient.sign = blobToSign => {
          const headers = 'x-goog-acl:public-read\nx-foo:bar\n';
          assert(blobToSign.indexOf(headers) > -1);
          done();
        };

        directoryFile.getSignedUrl(
          {
            action: 'read',
            expires: Date.now() + 2000,
            extensionHeaders,
          },
          assert.ifError
        );
      });
    });
  });

  describe('makePrivate', () => {
    it('should execute callback with API response', done => {
      const apiResponse = {};

      file.setMetadata = (metadata, query, callback) => {
        callback(null, apiResponse);
      };

      file.makePrivate((err, apiResponse_) => {
        assert.ifError(err);
        assert.strictEqual(apiResponse_, apiResponse);

        done();
      });
    });

    it('should execute callback with error & API response', done => {
      const error = new Error('Error.');
      const apiResponse = {};

      file.setMetadata = (metadata, query, callback) => {
        callback(error, apiResponse);
      };

      file.makePrivate((err, apiResponse_) => {
        assert.strictEqual(err, error);
        assert.strictEqual(apiResponse_, apiResponse);

        done();
      });
    });

    it('should make the file private to project by default', done => {
      file.setMetadata = (metadata, query) => {
        assert.deepStrictEqual(metadata, { acl: null });
        assert.deepStrictEqual(query, { predefinedAcl: 'projectPrivate' });
        done();
      };

      file.makePrivate(util.noop);
    });

    it('should make the file private to user if strict = true', done => {
      file.setMetadata = (metadata, query) => {
        assert.deepStrictEqual(query, { predefinedAcl: 'private' });
        done();
      };

      file.makePrivate({ strict: true }, util.noop);
    });

    it('should accept userProject', done => {
      const options = {
        userProject: 'user-project-id',
      };

      file.setMetadata = (metadata, query) => {
        assert.strictEqual(query.userProject, options.userProject);
        done();
      };

      file.makePrivate(options, assert.ifError);
    });
  });

  describe('makePublic', () => {
    it('should execute callback', done => {
      file.acl.add = (options, callback) => {
        callback();
      };

      file.makePublic(done);
    });

    it('should make the file public', done => {
      file.acl.add = options => {
        assert.deepStrictEqual(options, { entity: 'allUsers', role: 'READER' });
        done();
      };

      file.makePublic(util.noop);
    });
  });

  describe('move', () => {
    describe('copy to destination', () => {
      function assertCopyFile(file, expectedDestination, callback) {
        file.copy = destination => {
          assert.strictEqual(destination, expectedDestination);
          callback();
        };
      }

      it('should call copy with string', done => {
        const newFileName = 'new-file-name.png';
        assertCopyFile(file, newFileName, done);
        file.move(newFileName);
      });

      it('should call copy with Bucket', done => {
        assertCopyFile(file, BUCKET, done);
        file.move(BUCKET);
      });

      it('should call copy with File', done => {
        const newFile = new File(BUCKET, 'new-file');
        assertCopyFile(file, newFile, done);
        file.move(newFile);
      });

      it('should accept an options object', done => {
        const newFile = new File(BUCKET, 'name');
        const options = {};

        file.copy = (destination, options_) => {
          assert.strictEqual(options_, options);
          done();
        };

        file.move(newFile, options, assert.ifError);
      });

      it('should fail if copy fails', done => {
        const error = new Error('Error.');
        file.copy = (destination, options, callback) => {
          callback(error);
        };
        file.move('new-filename', err => {
          assert.strictEqual(err, error);
          done();
        });
      });
    });

    describe('delete original file', () => {
      it('should delete if copy is successful', done => {
        file.copy = (destination, options, callback) => {
          callback(null);
        };
        extend(file, {
          delete() {
            assert.strictEqual(this, file);
            done();
          },
        });
        file.move('new-filename');
      });

      it('should not delete if copy fails', done => {
        let deleteCalled = false;
        file.copy = (destination, options, callback) => {
          callback(new Error('Error.'));
        };
        file.delete = () => {
          deleteCalled = true;
        };
        file.move('new-filename', () => {
          assert.strictEqual(deleteCalled, false);
          done();
        });
      });

      it('should pass options to delete', done => {
        const options = {};

        file.copy = (destination, options, callback) => {
          callback();
        };

        file.delete = options_ => {
          assert.strictEqual(options_, options);
          done();
        };

        file.move('new-filename', options, assert.ifError);
      });

      it('should fail if delete fails', done => {
        const error = new Error('Error.');
        file.copy = (destination, options, callback) => {
          callback();
        };
        file.delete = (options, callback) => {
          callback(error);
        };
        file.move('new-filename', err => {
          assert.strictEqual(err, error);
          done();
        });
      });
    });
  });

  describe('request', () => {
    const USER_PROJECT = 'grape-spaceship-123';

    beforeEach(() => {
      file.userProject = USER_PROJECT;
    });

    it('should set the userProject if qs is undefined', done => {
      FakeServiceObject.prototype.request = reqOpts => {
        assert.strictEqual(reqOpts.qs.userProject, USER_PROJECT);
        done();
      };

      file.request({}, assert.ifError);
    });

    it('should set the userProject if field is undefined', done => {
      const options = {
        qs: {
          foo: 'bar',
        },
      };

      FakeServiceObject.prototype.request = reqOpts => {
        assert.strictEqual(reqOpts.qs, options.qs);
        assert.strictEqual(reqOpts.qs.userProject, USER_PROJECT);
        done();
      };

      file.request(options, assert.ifError);
    });

    it('should not overwrite the userProject', done => {
      const fakeUserProject = 'not-grape-spaceship-123';
      const options = {
        qs: {
          userProject: fakeUserProject,
        },
      };

      FakeServiceObject.prototype.request = reqOpts => {
        assert.strictEqual(reqOpts.qs.userProject, fakeUserProject);
        done();
      };

      file.request(options, assert.ifError);
    });

    it('should call ServiceObject#request correctly', done => {
      const options = {};

      extend(FakeServiceObject.prototype, {
        request(reqOpts, callback) {
          assert.strictEqual(this, file);
          assert.strictEqual(reqOpts, options);
          callback(); // done fn
        },
      });

      file.request(options, done);
    });
  });

  describe('rotateEncryptionKey', () => {
    it('should create new File correctly', done => {
      const options = {};

      file.bucket.file = (id, options_) => {
        assert.strictEqual(id, file.id);
        assert.strictEqual(options_, options);
        done();
      };

      file.rotateEncryptionKey(options, assert.ifError);
    });

    it('should default to customer-supplied encryption key', done => {
      const encryptionKey = 'encryption-key';

      file.bucket.file = (id, options) => {
        assert.strictEqual(options.encryptionKey, encryptionKey);
        done();
      };

      file.rotateEncryptionKey(encryptionKey, assert.ifError);
    });

    it('should accept a Buffer for customer-supplied encryption key', done => {
      const encryptionKey = crypto.randomBytes(32);

      file.bucket.file = (id, options) => {
        assert.strictEqual(options.encryptionKey, encryptionKey);
        done();
      };

      file.rotateEncryptionKey(encryptionKey, assert.ifError);
    });

    it('should call copy correctly', done => {
      const newFile = {};

      file.bucket.file = () => {
        return newFile;
      };

      file.copy = (destination, callback) => {
        assert.strictEqual(destination, newFile);
        callback(); // done()
      };

      file.rotateEncryptionKey({}, done);
    });
  });

  describe('save', () => {
    const DATA = 'Data!';

    it('should accept an options object', done => {
      const options = {};

      file.createWriteStream = options_ => {
        assert.strictEqual(options_, options);
        setImmediate(done);
        return new stream.PassThrough();
      };

      file.save(DATA, options, assert.ifError);
    });

    it('should not require options', done => {
      file.createWriteStream = options_ => {
        assert.deepStrictEqual(options_, {});
        setImmediate(done);
        return new stream.PassThrough();
      };

      file.save(DATA, assert.ifError);
    });

    it('should register the error listener', done => {
      file.createWriteStream = () => {
        const writeStream = new stream.PassThrough();
        writeStream.on('error', done);
        setImmediate(() => {
          writeStream.emit('error');
        });
        return writeStream;
      };

      file.save(DATA, assert.ifError);
    });

    it('should register the finish listener', done => {
      file.createWriteStream = () => {
        const writeStream = new stream.PassThrough();
        writeStream.once('finish', done);
        return writeStream;
      };

      file.save(DATA, assert.ifError);
    });

    it('should write the data', done => {
      file.createWriteStream = () => {
        const writeStream = new stream.PassThrough();
        writeStream.on('data', data => {
          assert.strictEqual(data.toString(), DATA);
          done();
        });
        return writeStream;
      };

      file.save(DATA, assert.ifError);
    });
  });

  describe('setMetadata', () => {
    it('should make the correct request', done => {
      const metadata = {};

      extend(file.parent, {
        setMetadata(metadata, options, callback) {
          assert.strictEqual(this, file);
          assert.deepStrictEqual(options, {});
          callback(); // done()
        },
      });

      file.setMetadata(metadata, done);
    });

    it('should accept options', done => {
      const options = {
        a: 'b',
        c: 'd',
      };

      file.parent.setMetadata = (metadata, options_) => {
        assert.deepStrictEqual(options_, options);
        done();
      };

      file.setMetadata({}, options, assert.ifError);
    });

    it('should use requestQueryObject', done => {
      const options = {
        a: 'b',
        c: 'd',
      };

      file.requestQueryObject = {
        generation: 2,
      };

      const expectedOptions = {
        a: 'b',
        c: 'd',
        generation: 2,
      };

      file.parent.setMetadata = (metadata, options) => {
        assert.deepStrictEqual(options, expectedOptions);
        done();
      };

      file.setMetadata({}, options, assert.ifError);
    });
  });

  describe('setStorageClass', () => {
    const STORAGE_CLASS = 'new_storage_class';

    it('should make the correct copy request', done => {
      file.copy = (newFile, options) => {
        assert.strictEqual(newFile, file);
        assert.deepStrictEqual(options, {
          storageClass: STORAGE_CLASS.toUpperCase(),
        });
        done();
      };

      file.setStorageClass(STORAGE_CLASS, assert.ifError);
    });

    it('should accept options', done => {
      const options = {
        a: 'b',
        c: 'd',
      };

      const expectedOptions = {
        a: 'b',
        c: 'd',
        storageClass: STORAGE_CLASS.toUpperCase(),
      };

      file.copy = (newFile, options) => {
        assert.deepStrictEqual(options, expectedOptions);
        done();
      };

      file.setStorageClass(STORAGE_CLASS, options, assert.ifError);
    });

    it('should convert camelCase to snake_case', done => {
      file.copy = (newFile, options) => {
        assert.strictEqual(options.storageClass, 'CAMEL_CASE');
        done();
      };

      file.setStorageClass('camelCase', assert.ifError);
    });

    it('should convert hyphenate to snake_case', done => {
      file.copy = (newFile, options) => {
        assert.strictEqual(options.storageClass, 'HYPHENATED_CLASS');
        done();
      };

      file.setStorageClass('hyphenated-class', assert.ifError);
    });

    describe('error', () => {
      const ERROR = new Error('Error.');
      const API_RESPONSE = {};

      beforeEach(() => {
        file.copy = (newFile, options, callback) => {
          callback(ERROR, null, API_RESPONSE);
        };
      });

      it('should execute callback with error & API response', done => {
        file.setStorageClass(STORAGE_CLASS, (err, apiResponse) => {
          assert.strictEqual(err, ERROR);
          assert.strictEqual(apiResponse, API_RESPONSE);
          done();
        });
      });
    });

    describe('success', () => {
      const METADATA = {};

      const COPIED_FILE = {
        metadata: METADATA,
      };

      const API_RESPONSE = {};

      beforeEach(() => {
        file.copy = (newFile, options, callback) => {
          callback(null, COPIED_FILE, API_RESPONSE);
        };
      });

      it('should update the metadata on the file', done => {
        file.setStorageClass(STORAGE_CLASS, err => {
          assert.ifError(err);
          assert.strictEqual(file.metadata, METADATA);
          done();
        });
      });

      it('should execute callback with api response', done => {
        file.setStorageClass(STORAGE_CLASS, (err, apiResponse) => {
          assert.ifError(err);
          assert.strictEqual(apiResponse, API_RESPONSE);
          done();
        });
      });
    });
  });

  describe('setEncryptionKey', () => {
    const KEY = crypto.randomBytes(32);
    // tslint:disable-next-line:no-any
    const KEY_BASE64 = Buffer.from(KEY as any).toString('base64');
    const KEY_HASH = crypto
      .createHash('sha256')
      // tslint:disable-next-line:no-any
      .update(KEY_BASE64, 'base64' as any)
      .digest('base64');
    let _file;

    beforeEach(() => {
      _file = file.setEncryptionKey(KEY);
    });

    it('should localize the key', () => {
      assert.strictEqual(file.encryptionKey, KEY);
    });

    it('should localize the base64 key', () => {
      assert.strictEqual(file.encryptionKeyBase64, KEY_BASE64);
    });

    it('should localize the hash', () => {
      assert.strictEqual(file.encryptionKeyHash, KEY_HASH);
    });

    it('should return the file instance', () => {
      assert.strictEqual(_file, file);
    });

    it('should push the correct request interceptor', done => {
      const expectedInterceptor = {
        headers: {
          'x-goog-encryption-algorithm': 'AES256',
          'x-goog-encryption-key': KEY_BASE64,
          'x-goog-encryption-key-sha256': KEY_HASH,
        },
      };

      assert.deepStrictEqual(
        file.interceptors[0].request({}),
        expectedInterceptor
      );
      assert.deepStrictEqual(
        file.encryptionKeyInterceptor.request({}),
        expectedInterceptor
      );

      done();
    });
  });

  describe('startResumableUpload_', () => {
    describe('starting', () => {
      it('should start a resumable upload', done => {
        const options = {
          metadata: {},
          offset: 1234,
          public: true,
          private: false,
          predefinedAcl: 'allUsers',
          uri: 'http://resumable-uri',
          userProject: 'user-project-id',
        };

        file.generation = 3;
        file.encryptionKey = 'key';
        file.kmsKeyName = 'kms-key-name';

        resumableUploadOverride = {
          upload(opts) {
            const bucket = file.bucket;
            const storage = bucket.storage;
            const authClient = storage.makeAuthenticatedRequest.authClient;

            assert.strictEqual(opts.authClient, authClient);
            assert.strictEqual(opts.bucket, bucket.name);
            assert.strictEqual(opts.file, file.name);
            assert.strictEqual(opts.generation, file.generation);
            assert.strictEqual(opts.key, file.encryptionKey);
            assert.strictEqual(opts.metadata, options.metadata);
            assert.strictEqual(opts.offset, options.offset);
            assert.strictEqual(opts.predefinedAcl, options.predefinedAcl);
            assert.strictEqual(opts.private, options.private);
            assert.strictEqual(opts.public, options.public);
            assert.strictEqual(opts.uri, options.uri);
            assert.strictEqual(opts.userProject, options.userProject);

            setImmediate(done);
            return through();
          },
        };

        file.startResumableUpload_(duplexify(), options);
      });

      it('should emit the response', done => {
        const resp = {};
        const uploadStream = through();

        resumableUploadOverride = {
          upload() {
            setImmediate(() => {
              uploadStream.emit('response', resp);
            });
            return uploadStream;
          },
        };

        uploadStream.on('response', resp_ => {
          assert.strictEqual(resp_, resp);
          done();
        });

        file.startResumableUpload_(duplexify());
      });

      it('should set the metadata from the metadata event', done => {
        const metadata = {};
        const uploadStream = through();

        resumableUploadOverride = {
          upload() {
            setImmediate(() => {
              uploadStream.emit('metadata', metadata);

              setImmediate(() => {
                assert.strictEqual(file.metadata, metadata);
                done();
              });
            });
            return uploadStream;
          },
        };

        file.startResumableUpload_(duplexify());
      });

      it('should emit complete after the stream finishes', done => {
        const dup = duplexify();

        dup.on('complete', done);

        resumableUploadOverride = {
          upload() {
            const uploadStream = new stream.Transform();
            setImmediate(() => {
              uploadStream.end();
            });
            return uploadStream;
          },
        };

        file.startResumableUpload_(dup);
      });

      it('should set the writable stream', done => {
        const dup = duplexify();
        const uploadStream = through();

        dup.setWritable = stream => {
          assert.strictEqual(stream, uploadStream);
          done();
        };

        resumableUploadOverride = {
          upload() {
            return uploadStream;
          },
        };

        file.startResumableUpload_(dup);
      });
    });
  });

  describe('startSimpleUpload_', () => {
    it('should get a writable stream', done => {
      makeWritableStreamOverride = () => {
        done();
      };

      file.startSimpleUpload_(duplexify());
    });

    it('should pass the required arguments', done => {
      const options = {
        metadata: {},
        predefinedAcl: 'allUsers',
        private: true,
        public: true,
      };

      makeWritableStreamOverride = (stream, options_) => {
        assert.strictEqual(options_.metadata, options.metadata);
        assert.deepStrictEqual(options_.request, {
          qs: {
            name: file.name,
            predefinedAcl: options.predefinedAcl,
          },
          uri:
            'https://www.googleapis.com/upload/storage/v1/b/' +
            file.bucket.name +
            '/o',
        });
        done();
      };

      file.startSimpleUpload_(duplexify(), options);
    });

    it('should set predefinedAcl when public: true', done => {
      makeWritableStreamOverride = (stream, options_) => {
        assert.strictEqual(options_.request.qs.predefinedAcl, 'publicRead');
        done();
      };

      file.startSimpleUpload_(duplexify(), { public: true });
    });

    it('should set predefinedAcl when private: true', done => {
      makeWritableStreamOverride = (stream, options_) => {
        assert.strictEqual(options_.request.qs.predefinedAcl, 'private');
        done();
      };

      file.startSimpleUpload_(duplexify(), { private: true });
    });

    it('should send query.ifGenerationMatch if File has one', done => {
      const versionedFile = new File(BUCKET, 'new-file.txt', { generation: 1 });

      makeWritableStreamOverride = (stream, options) => {
        assert.strictEqual(options.request.qs.ifGenerationMatch, 1);
        done();
      };

      versionedFile.startSimpleUpload_(duplexify(), {});
    });

    it('should send query.kmsKeyName if File has one', done => {
      file.kmsKeyName = 'kms-key-name';

      makeWritableStreamOverride = (stream, options) => {
        assert.strictEqual(options.request.qs.kmsKeyName, file.kmsKeyName);
        done();
      };

      file.startSimpleUpload_(duplexify(), {});
    });

    it('should send userProject if set', done => {
      const options = {
        userProject: 'user-project-id',
      };

      makeWritableStreamOverride = (stream, options_) => {
        assert.strictEqual(options_.request.qs.userProject, options.userProject);
        done();
      };

      file.startSimpleUpload_(duplexify(), options);
    });

    describe('request', () => {
      describe('error', () => {
        const error = new Error('Error.');

        beforeEach(() => {
          file.request = (reqOpts, callback) => {
            callback(error);
          };
        });

        it('should destroy the stream', done => {
          const stream = duplexify();

          file.startSimpleUpload_(stream);

          stream.on('error', err => {
            assert.strictEqual(stream.destroyed, true);
            assert.strictEqual(err, error);
            done();
          });
        });
      });

      describe('success', () => {
        const body = {};
        const resp = {};

        beforeEach(() => {
          file.request = (reqOpts, callback) => {
            callback(null, body, resp);
          };
        });

        it('should set the metadata', () => {
          const stream = duplexify();

          file.startSimpleUpload_(stream);

          assert.strictEqual(file.metadata, body);
        });

        it('should emit the response', done => {
          const stream = duplexify();

          stream.on('response', resp_ => {
            assert.strictEqual(resp_, resp);
            done();
          });

          file.startSimpleUpload_(stream);
        });

        it('should emit complete', done => {
          const stream = duplexify();

          stream.on('complete', done);

          file.startSimpleUpload_(stream);
        });
      });
    });
  });

  describe('setUserProject', () => {
    it('should set the userProject property', () => {
      const userProject = 'grape-spaceship-123';

      file.setUserProject(userProject);
      assert.strictEqual(file.userProject, userProject);
    });
  });
});
