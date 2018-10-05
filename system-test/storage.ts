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
import * as async from 'async';
import * as crypto from 'crypto';
import * as extend from 'extend';
import * as fs from 'fs';
import * as is from 'is';
import * as fetch from 'node-fetch';
import * as normalizeNewline from 'normalize-newline';
import * as path from 'path';
import * as through from 'through2';
import * as tmp from 'tmp';
import * as uuid from 'uuid';
import {util, ApiError, InstanceResponseCallback, BodyResponseCallback} from '@google-cloud/common';
import {Storage, Bucket} from '../src';
import {DeleteBucketCallback} from '../src/bucket';

// tslint:disable-next-line:variable-name
const PubSub = require('@google-cloud/pubsub');

describe('storage', () => {
  const USER_ACCOUNT = 'user-spsawchuk@gmail.com';
  const TESTS_PREFIX = 'gcloud-storage-tests-';

  const storage = new Storage({});
  const bucket = storage.bucket(generateName());

  const pubsub = new PubSub({
    projectId: process.env.PROJECT_ID,
  });
  let topic;

  const FILES = {
    logo: {
      path: path.join(
          __dirname, '../../system-test/data/CloudPlatform_128px_Retina.png'),
    },
    big: {
      path: path.join(__dirname, '../../system-test/data/three-mb-file.tif'),
      hash: undefined
    },
    html: {
      path: path.join(__dirname, '../../system-test/data/long-html-file.html'),
    },
    gzip: {
      path:
          path.join(__dirname, '../../system-test/data/long-html-file.html.gz'),
    },
  };

  before(() => {
    // tslint:disable-next-line:no-any
    return (bucket as any)
        .create()
        .then(() => {
          return pubsub.createTopic(generateName());
        })
        .then(data => {
          topic = data[0];
          return topic.iam.setPolicy({
            bindings: [
              {
                role: 'roles/pubsub.editor',
                members: ['allUsers'],
              },
            ],
          });
        });
  });

  after(done => {
    async.parallel([deleteAllBuckets, deleteAllTopics], done);
  });

  describe('without authentication', () => {
    let privateBucket;
    let privateFile;
    let storageWithoutAuth;

    let GOOGLE_APPLICATION_CREDENTIALS;

    before(done => {
      privateBucket = bucket;  // `bucket` was created in the global `before`
      privateFile = privateBucket.file('file-name');

      privateFile.save('data', err => {
        if (err) {
          done(err);
          return;
        }

        // CI authentication is done with ADC. Cache it here, restore it `after`
        GOOGLE_APPLICATION_CREDENTIALS =
            process.env.GOOGLE_APPLICATION_CREDENTIALS;
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

        const {Storage} = require('../src');
        storageWithoutAuth = new Storage();

        done();
      });
    });

    after(() => {
      process.env.GOOGLE_APPLICATION_CREDENTIALS =
          GOOGLE_APPLICATION_CREDENTIALS;
    });

    describe('public data', () => {
      let bucket;

      before(() => {
        bucket = storageWithoutAuth.bucket('gcp-public-data-landsat');
      });

      it('should list and download a file', done => {
        bucket.getFiles(
            {
              autoPaginate: false,
            },
            (err, files) => {
              assert.ifError(err);

              const file = files[0];

              file.download(done);
            });
      });
    });

    describe('private data', () => {
      let bucket;
      let file;

      before(() => {
        bucket = storageWithoutAuth.bucket(privateBucket.id);
        file = bucket.file(privateFile.id);
      });

      it('should not download a file', done => {
        file.download(err => {
          assert(err.message.indexOf('does not have storage.objects.get') > -1);
          done();
        });
      });

      it('should not upload a file', done => {
        file.save('new data', err => {
          assert(
              err.message.indexOf('Could not load the default credentials') >
              -1);
          done();
        });
      });
    });
  });

  describe('acls', () => {
    describe('buckets', () => {
      it('should get access controls', done => {
        bucket.acl.get((err, accessControls) => {
          assert.ifError(err);
          assert(Array.isArray(accessControls));
          done();
        });
      });

      it('should add entity to default access controls', done => {
        bucket.acl.default.add(
            {
              entity: USER_ACCOUNT,
              role: storage.acl.OWNER_ROLE,
            },
            (err, accessControl) => {
              assert.ifError(err);
              assert.strictEqual(accessControl.role, storage.acl.OWNER_ROLE);

              bucket.acl.default.get(
                  {
                    entity: USER_ACCOUNT,
                  },
                  (err, accessControl) => {
                    assert.ifError(err);
                    assert.strictEqual(
                        accessControl.role, storage.acl.OWNER_ROLE);

                    bucket.acl.default.update(
                        {
                          entity: USER_ACCOUNT,
                          role: storage.acl.READER_ROLE,
                        },
                        (err, accessControl) => {
                          assert.ifError(err);
                          assert.strictEqual(
                              accessControl.role, storage.acl.READER_ROLE);

                          bucket.acl.default.delete(
                              {entity: USER_ACCOUNT}, done);
                        });
                  });
            });
      });

      it('should get default access controls', done => {
        bucket.acl.default.get((err, accessControls) => {
          assert.ifError(err);
          assert(Array.isArray(accessControls));
          done();
        });
      });

      it('should grant an account access', done => {
        bucket.acl.add(
            {
              entity: USER_ACCOUNT,
              role: storage.acl.OWNER_ROLE,
            },
            (err, accessControl) => {
              assert.ifError(err);
              assert.strictEqual(accessControl.role, storage.acl.OWNER_ROLE);

              const opts = {entity: USER_ACCOUNT};

              bucket.acl.get(opts, (err, accessControl) => {
                assert.ifError(err);
                assert.strictEqual(accessControl.role, storage.acl.OWNER_ROLE);

                bucket.acl.delete(opts, done);
              });
            });
      });

      it('should update an account', done => {
        bucket.acl.add(
            {
              entity: USER_ACCOUNT,
              role: storage.acl.OWNER_ROLE,
            },
            (err, accessControl) => {
              assert.ifError(err);
              assert.strictEqual(accessControl.role, storage.acl.OWNER_ROLE);

              bucket.acl.update(
                  {
                    entity: USER_ACCOUNT,
                    role: storage.acl.WRITER_ROLE,
                  },
                  (err, accessControl) => {
                    assert.ifError(err);
                    assert.strictEqual(
                        accessControl.role, storage.acl.WRITER_ROLE);

                    bucket.acl.delete({entity: USER_ACCOUNT}, done);
                  });
            });
      });

      it('should make a bucket public', done => {
        bucket.makePublic(err => {
          assert.ifError(err);
          bucket.acl.get({entity: 'allUsers'}, (err, aclObject) => {
            assert.ifError(err);
            assert.deepStrictEqual(aclObject, {
              entity: 'allUsers',
              role: 'READER',
            });
            bucket.acl.delete({entity: 'allUsers'}, done);
          });
        });
      });

      it('should make files public', done => {
        async.each(['a', 'b', 'c'], createFileWithContent, err => {
          assert.ifError(err);
          bucket.makePublic({includeFiles: true}, err => {
            assert.ifError(err);
            bucket.getFiles((err, files) => {
              assert.ifError(err);
              async.each(files!, isFilePublic, err => {
                assert.ifError(err);
                async.parallel(
                    [
                      next =>
                          bucket.acl.default.delete({entity: 'allUsers'}, next),
                      next => bucket.deleteFiles(next)
                    ],
                    done);
              });
            });
          });
        });

        function createFileWithContent(content, callback) {
          bucket.file(generateName() + '.txt').save(content, callback);
        }

        function isFilePublic(file, callback) {
          file.acl.get({entity: 'allUsers'}, (err, aclObject) => {
            if (err) {
              callback(err);
              return;
            }

            if (aclObject.entity === 'allUsers' &&
                aclObject.role === 'READER') {
              callback();
            } else {
              callback(new Error('File is not public.'));
            }
          });
        }
      });

      it('should make a bucket private', done => {
        bucket.makePublic(err => {
          assert.ifError(err);
          bucket.makePrivate(err => {
            assert.ifError(err);
            bucket.acl.get({entity: 'allUsers'}, (err, aclObject) => {
              assert.strictEqual(err.code, 404);
              assert.strictEqual(err.message, 'Not Found');
              assert.strictEqual(aclObject, null);
              done();
            });
          });
        });
      });

      it('should make files private', done => {
        async.each(['a', 'b', 'c'], createFileWithContent, err => {
          assert.ifError(err);
          bucket.makePrivate({includeFiles: true}, err => {
            assert.ifError(err);
            bucket.getFiles((err, files) => {
              assert.ifError(err);
              async.each(files!, isFilePrivate, err => {
                assert.ifError(err);
                bucket.deleteFiles(done);
              });
            });
          });
        });

        function createFileWithContent(content, callback) {
          bucket.file(generateName() + '.txt').save(content, callback);
        }

        function isFilePrivate(file, callback) {
          file.acl.get({entity: 'allUsers'}, err => {
            if (err && err.code === 404) {
              callback();
            } else {
              callback(new Error('File is not private.'));
            }
          });
        }
      });
    });

    describe('files', () => {
      let file;

      beforeEach(done => {
        const options = {
          destination: generateName() + '.png',
        };

        bucket.upload(FILES.logo.path, options, (err, f) => {
          assert.ifError(err);
          file = f;
          done();
        });
      });

      afterEach(done => {
        file.delete(done);
      });

      it('should get access controls', done => {
        file.acl.get(done, (err, accessControls) => {
          assert.ifError(err);
          assert(Array.isArray(accessControls));
          done();
        });
      });

      it('should not expose default api', () => {
        assert.strictEqual(typeof file.default, 'undefined');
      });

      it('should grant an account access', done => {
        file.acl.add(
            {
              entity: USER_ACCOUNT,
              role: storage.acl.OWNER_ROLE,
            },
            (err, accessControl) => {
              assert.ifError(err);
              assert.strictEqual(accessControl.role, storage.acl.OWNER_ROLE);

              file.acl.get({entity: USER_ACCOUNT}, (err, accessControl) => {
                assert.ifError(err);
                assert.strictEqual(accessControl.role, storage.acl.OWNER_ROLE);

                file.acl.delete({entity: USER_ACCOUNT}, done);
              });
            });
      });

      it('should update an account', done => {
        file.acl.add(
            {
              entity: USER_ACCOUNT,
              role: storage.acl.OWNER_ROLE,
            },
            (err, accessControl) => {
              assert.ifError(err);
              assert.strictEqual(accessControl.role, storage.acl.OWNER_ROLE);

              file.acl.update(
                  {
                    entity: USER_ACCOUNT,
                    role: storage.acl.READER_ROLE,
                  },
                  (err, accessControl) => {
                    assert.ifError(err);

                    assert.strictEqual(
                        accessControl.role, storage.acl.READER_ROLE);

                    file.acl.delete({entity: USER_ACCOUNT}, done);
                  });
            });
      });

      it('should make a file public', done => {
        file.makePublic(err => {
          assert.ifError(err);
          file.acl.get({entity: 'allUsers'}, (err, aclObject) => {
            assert.ifError(err);
            assert.deepStrictEqual(aclObject, {
              entity: 'allUsers',
              role: 'READER',
            });
            file.acl.delete({entity: 'allUsers'}, done);
          });
        });
      });

      it('should make a file private', done => {
        file.makePublic(err => {
          assert.ifError(err);
          file.makePrivate(err => {
            assert.ifError(err);
            file.acl.get({entity: 'allUsers'}, (err, aclObject) => {
              assert.strictEqual(err.code, 404);
              assert.strictEqual(err.message, 'Not Found');
              assert.strictEqual(aclObject, null);
              done();
            });
          });
        });
      });

      it('should set custom encryption during the upload', done => {
        const key = '12345678901234567890123456789012';
        bucket.upload(
            FILES.big.path, {
              encryptionKey: key,
              resumable: false,
            },
            (err, file) => {
              assert.ifError(err);

              file.getMetadata((err, metadata) => {
                assert.ifError(err);
                assert.strictEqual(
                    metadata.customerEncryption.encryptionAlgorithm, 'AES256');
                done();
              });
            });
      });

      it('should set custom encryption in a resumable upload', done => {
        const key = crypto.randomBytes(32);

        bucket.upload(
            FILES.big.path, {
              encryptionKey: key,
              resumable: true,
            },
            (err, file) => {
              assert.ifError(err);

              file.getMetadata((err, metadata) => {
                assert.ifError(err);
                assert.strictEqual(
                    metadata.customerEncryption.encryptionAlgorithm, 'AES256');
                done();
              });
            });
      });

      it('should make a file public during the upload', done => {
        bucket.upload(
            FILES.big.path, {
              resumable: false,
              public: true,
            },
            (err, file) => {
              assert.ifError(err);

              file.acl.get({entity: 'allUsers'}, (err, aclObject) => {
                assert.ifError(err);
                assert.deepStrictEqual(aclObject, {
                  entity: 'allUsers',
                  role: 'READER',
                });
                done();
              });
            });
      });

      it('should make a file public from a resumable upload', done => {
        bucket.upload(
            FILES.big.path, {
              resumable: true,
              public: true,
            },
            (err, file) => {
              assert.ifError(err);

              file.acl.get({entity: 'allUsers'}, (err, aclObject) => {
                assert.ifError(err);
                assert.deepStrictEqual(aclObject, {
                  entity: 'allUsers',
                  role: 'READER',
                });
                done();
              });
            });
      });

      it('should make a file private from a resumable upload', done => {
        bucket.upload(
            FILES.big.path, {
              resumable: true,
              private: true,
            },
            (err, file) => {
              assert.ifError(err);

              file.acl.get({entity: 'allUsers'}, (err, aclObject) => {
                assert.strictEqual(err.code, 404);
                assert.strictEqual(err.message, 'Not Found');
                assert.strictEqual(aclObject, null);
                done();
              });
            });
      });
    });
  });

  describe('iam', () => {
    let PROJECT_ID;

    before(done => {
      storage.authClient.getProjectId((err, projectId) => {
        if (err) {
          done(err);
          return;
        }

        PROJECT_ID = projectId;
        done();
      });
    });

    describe('buckets', () => {
      let bucket;

      before(() => {
        bucket = storage.bucket(generateName());
        return bucket.create();
      });

      it('should get a policy', done => {
        bucket.iam.getPolicy((err, policy) => {
          assert.ifError(err);

          assert.deepStrictEqual(policy.bindings, [
            {
              members: [
                'projectEditor:' + PROJECT_ID,
                'projectOwner:' + PROJECT_ID,
              ],
              role: 'roles/storage.legacyBucketOwner',
            },
            {
              members: ['projectViewer:' + PROJECT_ID],
              role: 'roles/storage.legacyBucketReader',
            },
          ]);

          done();
        });
      });

      it('should set a policy', done => {
        bucket.iam.getPolicy((err, policy) => {
          assert.ifError(err);

          policy.bindings.push({
            role: 'roles/storage.legacyBucketReader',
            members: ['allUsers'],
          });

          bucket.iam.setPolicy(policy, (err, newPolicy) => {
            assert.ifError(err);

            const legacyBucketReaderBinding =
                newPolicy.bindings.filter(binding => {
                  return binding.role === 'roles/storage.legacyBucketReader';
                })[0];

            assert(legacyBucketReaderBinding.members.includes('allUsers'));

            done();
          });
        });
      });

      it('should test the iam permissions', done => {
        const testPermissions = [
          'storage.buckets.get',
          'storage.buckets.getIamPolicy',
        ];

        bucket.iam.testPermissions(testPermissions, (err, permissions) => {
          assert.ifError(err);

          assert.deepStrictEqual(permissions, {
            'storage.buckets.get': true,
            'storage.buckets.getIamPolicy': true,
          });

          done();
        });
      });
    });
  });

  describe('unicode validation', () => {
    let bucket;

    before(() => {
      bucket = storage.bucket('storage-library-test-bucket');
    });

    // Normalization form C: a single character for e-acute;
    // URL should end with Cafe%CC%81
    it('should not perform normalization form C', () => {
      const name = 'Caf\u00e9';
      const file = bucket.file(name);

      const expectedContents = 'Normalization Form C';

      return file.get()
          .then(data => {
            const receivedFile = data[0];
            assert.strictEqual(receivedFile.name, name);
            return receivedFile.download();
          })
          .then(contents => {
            assert.strictEqual(contents.toString(), expectedContents);
          });
    });

    // Normalization form D: an ASCII character followed by U+0301 combining
    // character; URL should end with Caf%C3%A9
    it('should not perform normalization form D', () => {
      const name = 'Cafe\u0301';
      const file = bucket.file(name);

      const expectedContents = 'Normalization Form D';

      return file.get()
          .then(data => {
            const receivedFile = data[0];
            assert.strictEqual(receivedFile.name, name);
            return receivedFile.download();
          })
          .then(contents => {
            assert.strictEqual(contents.toString(), expectedContents);
          });
    });
  });

  describe('getting buckets', () => {
    const bucketsToCreate = [generateName(), generateName()];

    before(done => {
      async.map(bucketsToCreate, storage.createBucket.bind(storage), done);
    });

    after(done => {
      async.series(
          bucketsToCreate.map(bucket => {
            return done => {
              storage.bucket(bucket).delete(done);
            };
          }),
          done);
    });

    it('should get buckets', done => {
      storage.getBuckets((err, buckets) => {
        const createdBuckets = buckets.filter(bucket => {
          return bucketsToCreate.indexOf(bucket.name) > -1;
        });

        assert.strictEqual(createdBuckets.length, bucketsToCreate.length);
        done();
      });
    });

    it('should get buckets as a stream', done => {
      let bucketEmitted = false;

      storage.getBucketsStream()
          .on('error', done)
          .on('data',
              bucket => {
                bucketEmitted = bucket instanceof Bucket;
              })
          .on('end', () => {
            assert.strictEqual(bucketEmitted, true);
            done();
          });
    });
  });

  describe('bucket metadata', () => {
    it('should allow setting metadata on a bucket', done => {
      const metadata = {
        website: {
          mainPageSuffix: 'http://fakeuri',
          notFoundPage: 'http://fakeuri/404.html',
        },
      };

      bucket.setMetadata(metadata, (err, meta) => {
        assert.ifError(err);
        assert.deepStrictEqual(meta.website, metadata.website);
        done();
      });
    });

    it('should allow changing the storage class', done => {
      const bucket = storage.bucket(generateName());

      async.series(
          [
            next => {
              bucket.create(next);
            },

            next => {
              bucket.getMetadata((err, metadata) => {
                assert.ifError(err);
                assert.strictEqual(metadata.storageClass, 'STANDARD');
                next();
              });
            },

            next => {
              bucket.setStorageClass('multi-regional', next);
            },
          ],
          err => {
            assert.ifError(err);

            bucket.getMetadata((err, metadata) => {
              assert.ifError(err);
              assert.strictEqual(metadata.storageClass, 'MULTI_REGIONAL');
              done();
            });
          });
    });

    describe('labels', () => {
      const LABELS = {
        label: 'labelvalue',  // no caps or spaces allowed (?)
        labeltwo: 'labelvaluetwo',
      };

      beforeEach(done => {
        bucket.deleteLabels(done);
      });

      it('should set labels', done => {
        bucket.setLabels(LABELS, err => {
          assert.ifError(err);

          bucket.getLabels((err, labels) => {
            assert.ifError(err);
            assert.deepStrictEqual(labels, LABELS);
            done();
          });
        });
      });

      it('should update labels', done => {
        const newLabels = {
          siblinglabel: 'labelvalue',
        };

        bucket.setLabels(LABELS, err => {
          assert.ifError(err);

          bucket.setLabels(newLabels, err => {
            assert.ifError(err);

            bucket.getLabels((err, labels) => {
              assert.ifError(err);
              assert.deepStrictEqual(labels, extend({}, LABELS, newLabels));
              done();
            });
          });
        });
      });

      it('should delete a single label', done => {
        if (Object.keys(LABELS).length <= 1) {
          done(new Error('Maintainer Error: `LABELS` needs 2 labels.'));
          return;
        }

        const labelKeyToDelete = Object.keys(LABELS)[0];

        bucket.setLabels(LABELS, err => {
          assert.ifError(err);

          bucket.deleteLabels(labelKeyToDelete, err => {
            assert.ifError(err);

            bucket.getLabels((err, labels) => {
              assert.ifError(err);

              const expectedLabels = extend({}, LABELS);
              delete expectedLabels[labelKeyToDelete];

              assert.deepStrictEqual(labels, expectedLabels);

              done();
            });
          });
        });
      });

      it('should delete all labels', done => {
        bucket.deleteLabels(err => {
          assert.ifError(err);

          bucket.getLabels((err, labels) => {
            assert.ifError(err);
            assert.deepStrictEqual(labels, {});
            done();
          });
        });
      });
    });
  });

  describe('requester pays', () => {
    const HAS_2ND_PROJECT = is.defined(process.env.GCN_STORAGE_2ND_PROJECT_ID);
    let bucket;

    before(done => {
      bucket = storage.bucket(generateName());

      bucket.create(
          {
            requesterPays: true,
          },
          done);
    });

    after(done => {
      bucket.delete(done);
    });

    it('should have enabled requesterPays functionality', done => {
      bucket.getMetadata((err, metadata) => {
        assert.ifError(err);
        assert.strictEqual(metadata.billing.requesterPays, true);
        done();
      });
    });

    // These tests will verify that the requesterPays functionality works from
    // the perspective of another project.
    (HAS_2ND_PROJECT ? describe : describe.skip)('existing bucket', () => {
      const storageNonWhitelist = new Storage({
        projectId: process.env.GCN_STORAGE_2ND_PROJECT_ID,
        keyFilename: process.env.GCN_STORAGE_2ND_PROJECT_KEY,
      });
      let bucket;  // the source bucket, which will have requesterPays enabled.
      let bucketNonWhitelist;  // the bucket object from the requesting user.

      function isRequesterPaysEnabled(callback) {
        bucket.getMetadata((err, metadata) => {
          if (err) {
            callback(err);
            return;
          }

          const billing = metadata.billing || {};
          callback(null, !!billing && billing.requesterPays === true);
        });
      }

      before(done => {
        bucket = storage.bucket(generateName());
        bucketNonWhitelist = storageNonWhitelist.bucket(bucket.name);
        bucket.create(done);
      });

      it('should enable requesterPays', done => {
        isRequesterPaysEnabled((err, isEnabled) => {
          assert.ifError(err);
          assert.strictEqual(isEnabled, false);

          bucket.enableRequesterPays(err => {
            assert.ifError(err);

            isRequesterPaysEnabled((err, isEnabled) => {
              assert.ifError(err);
              assert.strictEqual(isEnabled, true);
              done();
            });
          });
        });
      });

      it('should disable requesterPays', done => {
        bucket.enableRequesterPays(err => {
          assert.ifError(err);

          isRequesterPaysEnabled((err, isEnabled) => {
            assert.ifError(err);
            assert.strictEqual(isEnabled, true);

            bucket.disableRequesterPays(err => {
              assert.ifError(err);

              isRequesterPaysEnabled((err, isEnabled) => {
                assert.ifError(err);
                assert.strictEqual(isEnabled, false);
                done();
              });
            });
          });
        });
      });

      describe('methods that accept userProject', () => {
        let file;
        let notification;
        let topicName;

        const USER_PROJECT_OPTIONS = {
          userProject: process.env.GCN_STORAGE_2ND_PROJECT_ID,
        };

        // This acts as a test for the following methods:
        //
        // - file.save()
        //   -> file.createWriteStream()
        before(() => {
          file = bucketNonWhitelist.file(generateName());

          return bucket.enableRequesterPays()
              .then(() => bucket.iam.getPolicy())
              .then(data => {
                const policy = data[0];

                // Allow an absolute or relative path (from project root)
                // for the key file.
                let key2 = process.env.GCN_STORAGE_2ND_PROJECT_KEY;
                if (key2 && key2.charAt(0) === '.') {
                  key2 = `${__dirname}/../../${key2}`;
                }

                // Get the service account for the "second" account (the
                // one that will read the requester pays file).
                const clientEmail = require(key2!).client_email;

                policy.bindings.push({
                  role: 'roles/storage.admin',
                  members: [`serviceAccount:${clientEmail}`],
                });

                return bucket.iam.setPolicy(policy);
              })
              .then(() => file.save('abc', USER_PROJECT_OPTIONS))
              .then(() => topic.getMetadata())
              .then(data => {
                topicName = data[0].name;
              });
        });

        // This acts as a test for the following methods:
        //
        //  - bucket.delete({ userProject: ... })
        //    -> bucket.deleteFiles({ userProject: ... })
        //       -> bucket.getFiles({ userProject: ... })
        //          -> file.delete({ userProject: ... })
        after(done => {
          deleteBucket(bucketNonWhitelist, USER_PROJECT_OPTIONS, done);
        });

        function doubleTest(testFunction) {
          const failureMessage =
              'Bucket is requester pays bucket but no user project provided.';

          return done => {
            async.series(
                [
                  next => {
                    testFunction({}, err => {
                      assert(err.message.indexOf(failureMessage) > -1);
                      next();
                    });
                  },

                  next => {
                    testFunction(USER_PROJECT_OPTIONS, next);
                  },
                ],
                done);
          };
        }

        it('bucket#combine', done => {
          const files = [
            {file: bucketNonWhitelist.file('file-one.txt'), contents: '123'},
            {file: bucketNonWhitelist.file('file-two.txt'), contents: '456'},
          ];

          async.each(files, createFile, err => {
            assert.ifError(err);

            const sourceFiles = files.map(x => x.file);
            const destinationFile =
                bucketNonWhitelist.file('file-one-n-two.txt');

            bucketNonWhitelist.combine(
                sourceFiles, destinationFile, USER_PROJECT_OPTIONS, done);
          });

          function createFile(fileObject, callback) {
            fileObject.file.save(
                fileObject.contents, USER_PROJECT_OPTIONS, callback);
          }
        });

        it('bucket#createNotification', doubleTest((options, done) => {
             bucketNonWhitelist.createNotification(
                 topicName, options, (err, _notification) => {
                   notification = _notification;
                   done(err);
                 });
           }));

        it('bucket#exists', doubleTest((options, done) => {
             bucketNonWhitelist.exists(options, done);
           }));

        it('bucket#get', doubleTest((options, done) => {
             bucketNonWhitelist.get(options, done);
           }));

        it('bucket#getMetadata', doubleTest((options, done) => {
             bucketNonWhitelist.get(options, done);
           }));

        it('bucket#getNotifications', doubleTest((options, done) => {
             bucketNonWhitelist.getNotifications(options, done);
           }));

        it('bucket#makePrivate', doubleTest((options, done) => {
             bucketNonWhitelist.makePrivate(options, done);
           }));

        it('bucket#setMetadata', doubleTest((options, done) => {
             bucketNonWhitelist.setMetadata({newMetadata: true}, options, done);
           }));

        it('bucket#setStorageClass', doubleTest((options, done) => {
             bucketNonWhitelist.setStorageClass(
                 'multi-regional', options, done);
           }));

        it('bucket#upload', doubleTest((options, done) => {
             bucketNonWhitelist.upload(FILES.big.path, options, done);
           }));

        it('file#copy', doubleTest((options, done) => {
             file.copy('new-file.txt', options, done);
           }));

        it('file#createReadStream', doubleTest((options, done) => {
             file.createReadStream(options)
                 .on('error', done)
                 .on('end', done)
                 .on('data', util.noop);
           }));

        it('file#createResumableUpload', doubleTest((options, done) => {
             file.createResumableUpload(options, (err, uri) => {
               if (err) {
                 done(err);
                 return;
               }

               file.createWriteStream({uri})
                   .on('error', done)
                   .on('finish', done)
                   .end('Test data');
             });
           }));

        it('file#download', doubleTest((options, done) => {
             file.download(options, done);
           }));

        it('file#exists', doubleTest((options, done) => {
             file.exists(options, done);
           }));

        it('file#get', doubleTest((options, done) => {
             file.get(options, done);
           }));

        it('file#getMetadata', doubleTest((options, done) => {
             file.getMetadata(options, done);
           }));

        it('file#makePrivate', doubleTest((options, done) => {
             file.makePrivate(options, done);
           }));

        it('file#move', doubleTest((options, done) => {
             const newFile = bucketNonWhitelist.file(generateName());

             file.move(newFile, options, err => {
               if (err) {
                 done(err);
                 return;
               }

               // Re-create the file. The tests need it.
               file.save('newcontent', options, done);
             });
           }));

        it('file#setMetadata', doubleTest((options, done) => {
             file.setMetadata({newMetadata: true}, options, done);
           }));

        it('file#setStorageClass', doubleTest((options, done) => {
             file.setStorageClass('multi-regional', options, done);
           }));

        it('acl#add', doubleTest((options, done) => {
             options = extend(
                 {
                   entity: USER_ACCOUNT,
                   role: storage.acl.OWNER_ROLE,
                 },
                 options);

             bucketNonWhitelist.acl.add(options, done);
           }));

        it('acl#update', doubleTest((options, done) => {
             options = extend(
                 {
                   entity: USER_ACCOUNT,
                   role: storage.acl.WRITER_ROLE,
                 },
                 options);

             bucketNonWhitelist.acl.update(options, done);
           }));

        it('acl#get', doubleTest((options, done) => {
             options = extend(
                 {
                   entity: USER_ACCOUNT,
                 },
                 options);

             bucketNonWhitelist.acl.get(options, done);
           }));

        it('acl#delete', doubleTest((options, done) => {
             options = extend(
                 {
                   entity: USER_ACCOUNT,
                 },
                 options);

             bucketNonWhitelist.acl.delete(options, done);
           }));

        it('iam#getPolicy', doubleTest((options, done) => {
             bucketNonWhitelist.iam.getPolicy(options, done);
           }));

        it('iam#setPolicy', doubleTest((options, done) => {
             bucket.iam.getPolicy((err, policy) => {
               if (err) {
                 done(err);
                 return;
               }

               policy.bindings.push({
                 role: 'roles/storage.objectViewer',
                 members: ['allUsers'],
               });

               bucketNonWhitelist.iam.setPolicy(policy, options, done);
             });
           }));

        // @TODO: There may be a backend bug here.
        // Reference:
        // https://github.com/googleapis/nodejs-storage/pull/190#issuecomment-388475406
        it.skip('iam#testPermissions', doubleTest((options, done) => {
                  const tests = ['storage.buckets.delete'];
                  bucketNonWhitelist.iam.testPermissions(tests, options, done);
                }));

        it('notification#get', doubleTest((options, done) => {
             if (!notification) {
               throw new Error('Notification was not successfully created.');
             }

             notification.get(options, done);
           }));

        it('notification#getMetadata', doubleTest((options, done) => {
             if (!notification) {
               throw new Error('Notification was not successfully created.');
             }

             notification.getMetadata(options, done);
           }));

        it('notification#delete', doubleTest((options, done) => {
             if (!notification) {
               throw new Error('Notification was not successfully created.');
             }

             notification.delete(options, done);
           }));
      });
    });
  });

  describe('write, read, and remove files', () => {
    before(done => {
      function setHash(filesKey, done) {
        const file = FILES[filesKey];
        const hash = crypto.createHash('md5');

        fs.createReadStream(file.path)
            .on('data', hash.update.bind(hash))
            .on('end', () => {
              file.hash = hash.digest('base64');
              done();
            });
      }

      async.each(Object.keys(FILES), setHash, done);
    });

    it('should read/write from/to a file in a directory', done => {
      const file = bucket.file('directory/file');
      const contents = 'test';

      const writeStream = file.createWriteStream({resumable: false});
      writeStream.write(contents);
      writeStream.end();

      writeStream.on('error', done);
      writeStream.on('finish', () => {
        let data = Buffer.from('');

        file.createReadStream()
            .on('error', done)
            .on('data',
                chunk => {
                  data = Buffer.concat([data, chunk]);
                })
            .on('end', () => {
              assert.strictEqual(data.toString(), contents);
              done();
            });
      });
    });

    it('should not push data when a file cannot be read', done => {
      const file = bucket.file('non-existing-file');
      let dataEmitted = false;

      file.createReadStream()
          .on('data',
              () => {
                dataEmitted = true;
              })
          .on('error', err => {
            assert.strictEqual(dataEmitted, false);
            assert.strictEqual((err as ApiError).code, 404);
            done();
          });
    });

    it('should read a byte range from a file', done => {
      bucket.upload(FILES.big.path, (err, file) => {
        assert.ifError(err);

        const fileSize = file.metadata.size;
        const byteRange = {
          start: Math.floor((fileSize * 1) / 3),
          end: Math.floor((fileSize * 2) / 3),
        };
        const expectedContentSize = byteRange.start + 1;

        let sizeStreamed = 0;
        file.createReadStream(byteRange)
            .on('data',
                chunk => {
                  sizeStreamed += chunk.length;
                })
            .on('error', done)
            .on('end', () => {
              assert.strictEqual(sizeStreamed, expectedContentSize);
              file.delete(done);
            });
      });
    });

    it('should download a file to memory', done => {
      const fileContents = fs.readFileSync(FILES.big.path);

      bucket.upload(FILES.big.path, (err, file) => {
        assert.ifError(err);

        file.download((err, remoteContents) => {
          assert.ifError(err);
          assert.strictEqual(String(fileContents), String(remoteContents));
          done();
        });
      });
    });

    it('should handle non-network errors', done => {
      const file = bucket.file('hi.jpg');
      file.download(err => {
        assert.strictEqual((err as ApiError).code, 404);
        done();
      });
    });

    it('should gzip a file on the fly and download it', done => {
      const options = {
        gzip: true,
      };

      const expectedContents = fs.readFileSync(FILES.html.path, 'utf-8');

      bucket.upload(FILES.html.path, options, (err, file) => {
        assert.ifError(err);

        file.download((err, contents) => {
          assert.ifError(err);
          assert.strictEqual(contents.toString(), expectedContents);
          file.delete(done);
        });
      });
    });

    it('should upload a gzipped file and download it', done => {
      const options = {
        metadata: {
          contentEncoding: 'gzip',
          contentType: 'text/html',
        },
      };

      const expectedContents =
          normalizeNewline(fs.readFileSync(FILES.html.path, 'utf-8'));

      bucket.upload(FILES.gzip.path, options, (err, file) => {
        assert.ifError(err);

        // Sometimes this file is not found immediately; include some
        // retry to attempt to make the test less flaky.
        let attempt = 0;
        const downloadCallback = (err, contents) => {
          // If we got an error, gracefully retry a few times.
          if (err) {
            attempt += 1;
            if (attempt >= 5) {
              return assert.ifError(err);
            }
            return file.download(downloadCallback);
          }

          // Ensure the contents match.
          assert.strictEqual(contents.toString(), expectedContents);
          file.delete(done);
        };
        file.download(downloadCallback);
      });
    });

    describe('simple write', () => {
      it('should save arbitrary data', done => {
        const file = bucket.file('TestFile');
        const data = 'hello';

        file.save(data, err => {
          assert.ifError(err);

          file.download((err, contents) => {
            assert.strictEqual(contents.toString(), data);
            done();
          });
        });
      });
    });

    describe('stream write', () => {
      it('should stream write, then remove file (3mb)', done => {
        const file = bucket.file('LargeFile');
        fs.createReadStream(FILES.big.path)
            .pipe(file.createWriteStream({resumable: false}))
            .on('error', done)
            .on('finish', () => {
              assert.strictEqual(file.metadata.md5Hash, FILES.big.hash);
              file.delete(done);
            });
      });

      it('should write metadata', done => {
        const options = {
          metadata: {contentType: 'image/png'},
          resumable: false,
        };

        bucket.upload(FILES.logo.path, options, (err, file) => {
          assert.ifError(err);

          file.getMetadata((err, metadata) => {
            assert.ifError(err);
            assert.strictEqual(
                metadata.contentType, options.metadata.contentType);
            file.delete(done);
          });
        });
      });

      it('should resume an upload after an interruption', done => {
        fs.stat(FILES.big.path, (err, metadata) => {
          assert.ifError(err);

          // Use a random name to force an empty ConfigStore cache.
          const file = bucket.file(generateName());
          const fileSize = metadata.size;

          upload({interrupt: true}, err => {
            assert.strictEqual(err.message, 'Interrupted.');
            upload({interrupt: false}, err => {
              assert.ifError(err);
              assert.strictEqual(Number(file.metadata.size), fileSize);
              file.delete(done);
            });
          });

          function upload(opts, callback) {
            const ws = file.createWriteStream();
            let sizeStreamed = 0;

            fs.createReadStream(FILES.big.path)
                .pipe(through(function(chunk, enc, next) {
                  sizeStreamed += chunk.length;

                  if (opts.interrupt && sizeStreamed >= fileSize / 2) {
                    // stop sending data half way through.
                    this.push(chunk);
                    this.destroy();
                    ws.destroy(new Error('Interrupted.'));
                  } else {
                    this.push(chunk);
                    next();
                  }
                }))
                .pipe(ws)
                .on('error', callback)
                .on('finish', callback);
          }
        });
      });

      it('should write/read/remove from a buffer', done => {
        tmp.setGracefulCleanup();
        tmp.file(function _tempFileCreated(err, tmpFilePath) {
          assert.ifError(err);

          const file = bucket.file('MyBuffer');
          const fileContent = 'Hello World';

          const writable = file.createWriteStream();

          writable.write(fileContent);
          writable.end();

          writable.on('finish', () => {
            file.createReadStream()
                .on('error', done)
                .pipe(fs.createWriteStream(tmpFilePath))
                .on('error', done)
                .on('finish', () => {
                  file.delete(err => {
                    assert.ifError(err);

                    fs.readFile(tmpFilePath, (err, data) => {
                      assert.strictEqual(data.toString(), fileContent);
                      done();
                    });
                  });
                });
          });
        });
      });
    });

    describe('customer-supplied encryption keys', () => {
      const encryptionKey = crypto.randomBytes(32);

      const file = bucket.file('encrypted-file', {
        encryptionKey,
      });
      const unencryptedFile = bucket.file(file.name);

      before(done => {
        file.save('secret data', {resumable: false}, done);
      });

      it('should not get the hashes from the unencrypted file', done => {
        unencryptedFile.getMetadata((err, metadata) => {
          assert.ifError(err);
          assert.strictEqual(metadata.crc32c, undefined);
          done();
        });
      });

      it('should get the hashes from the encrypted file', done => {
        file.getMetadata((err, metadata) => {
          assert.ifError(err);
          assert.notStrictEqual(metadata.crc32c, undefined);
          done();
        });
      });

      it('should not download from the unencrypted file', done => {
        unencryptedFile.download(err => {
          assert(err!.message.indexOf([
            'The target object is encrypted by a',
            'customer-supplied encryption key.',
          ].join(' ')) > -1);
          done();
        });
      });

      it('should download from the encrytped file', done => {
        file.download((err, contents) => {
          assert.ifError(err);
          assert.strictEqual(contents.toString(), 'secret data');
          done();
        });
      });

      it('should rotate encryption keys', done => {
        const newEncryptionKey = crypto.randomBytes(32);

        file.rotateEncryptionKey(newEncryptionKey, err => {
          assert.ifError(err);
          file.download((err, contents) => {
            assert.ifError(err);
            assert.strictEqual(contents.toString(), 'secret data');
            done();
          });
        });
      });
    });

    describe('kms keys', () => {
      const FILE_CONTENTS = 'secret data';

      const BUCKET_LOCATION = 'us';
      let PROJECT_ID;
      let SERVICE_ACCOUNT_EMAIL;

      const keyRingId = generateName();
      const cryptoKeyId = generateName();

      let bucket;
      let kmsKeyName;
      let keyRingsBaseUrl;

      function setProjectId(projectId) {
        PROJECT_ID = projectId;
        keyRingsBaseUrl = `https://cloudkms.googleapis.com/v1/projects/${
            PROJECT_ID}/locations/${BUCKET_LOCATION}/keyRings`;
        kmsKeyName = generateKmsKeyName(cryptoKeyId);
      }

      function generateKmsKeyName(cryptoKeyId) {
        return `projects/${PROJECT_ID}/locations/${BUCKET_LOCATION}/keyRings/${
            keyRingId}/cryptoKeys/${cryptoKeyId}`;
      }

      function createCryptoKey(cryptoKeyId, callback) {
        async.series(
            [
              function createCryptoKeyId(next) {
                storage.request(
                    {
                      method: 'POST',
                      uri: `${keyRingsBaseUrl}/${keyRingId}/cryptoKeys`,
                      qs: {cryptoKeyId},
                      json: {purpose: 'ENCRYPT_DECRYPT'},
                    },
                    next as BodyResponseCallback);
              },

              function getServiceAccountEmail(next) {
                if (SERVICE_ACCOUNT_EMAIL) {
                  setImmediate(next);
                  return;
                }

                storage.getServiceAccount((err, serviceAccount) => {
                  if (err) {
                    next(err);
                    return;
                  }

                  SERVICE_ACCOUNT_EMAIL = serviceAccount.emailAddress;

                  next();
                });
              },

              function grantPermissionToServiceAccount(next) {
                storage.request(
                    {
                      method: 'POST',
                      uri: `${keyRingsBaseUrl}/${keyRingId}/cryptoKeys/${
                          cryptoKeyId}:setIamPolicy`,
                      json: {
                        policy: {
                          bindings: [
                            {
                              role:
                                  'roles/cloudkms.cryptoKeyEncrypterDecrypter',
                              members:
                                  `serviceAccount:${SERVICE_ACCOUNT_EMAIL}`,
                            },
                          ],
                        },
                      },
                    },
                    next as BodyResponseCallback);
              },
            ],
            callback);
      }

      before(done => {
        bucket = storage.bucket(generateName(), {location: BUCKET_LOCATION});
        async.series(
            [
              function getProjectId(next) {
                storage.authClient.getProjectId((err, projectId) => {
                  if (err) {
                    next(err);
                    return;
                  }
                  setProjectId(projectId);
                  next();
                });
              },

              function createBucket(next) {
                bucket.create(next);
              },

              function createKeyRing(next) {
                storage.request(
                    {
                      method: 'POST',
                      uri: keyRingsBaseUrl,
                      qs: {keyRingId},
                    },
                    next);
              },

              next => {
                createCryptoKey(cryptoKeyId, next);
              },
            ],
            done);
      });

      describe('files', () => {
        let file;

        before(done => {
          file = bucket.file('kms-encrypted-file', {kmsKeyName});
          file.save(FILE_CONTENTS, {resumable: false}, done);
        });

        it('should have set kmsKeyName on created file', done => {
          file.getMetadata((err, metadata) => {
            assert.ifError(err);

            // Strip the project ID, as it could be the placeholder locally, but
            // the real value upstream.
            const projectIdRegExp = /^.+\/locations/;
            const actualKmsKeyName =
                metadata.kmsKeyName.replace(projectIdRegExp, '');
            let expectedKmsKeyName = kmsKeyName.replace(projectIdRegExp, '');

            // Upstream attaches a version.
            expectedKmsKeyName = `${expectedKmsKeyName}/cryptoKeyVersions/1`;

            assert.strictEqual(actualKmsKeyName, expectedKmsKeyName);

            done();
          });
        });

        it('should set kmsKeyName on resumable uploaded file', done => {
          const file = bucket.file('resumable-file', {kmsKeyName});

          file.save(FILE_CONTENTS, {resumable: true}, err => {
            assert.ifError(err);

            file.getMetadata((err, metadata) => {
              assert.ifError(err);

              // Strip the project ID, as it could be the placeholder locally,
              // but the real value upstream.
              const projectIdRegExp = /^.+\/locations/;
              const actualKmsKeyName =
                  metadata.kmsKeyName.replace(projectIdRegExp, '');
              let expectedKmsKeyName = kmsKeyName.replace(projectIdRegExp, '');

              // Upstream attaches a version.
              expectedKmsKeyName = `${expectedKmsKeyName}/cryptoKeyVersions/1`;

              assert.strictEqual(actualKmsKeyName, expectedKmsKeyName);

              done();
            });
          });
        });

        it('should rotate encryption keys', done => {
          const cryptoKeyId = generateName();
          const newKmsKeyName = generateKmsKeyName(cryptoKeyId);

          createCryptoKey(cryptoKeyId, err => {
            assert.ifError(err);

            file.rotateEncryptionKey({kmsKeyName: newKmsKeyName}, err => {
              assert.ifError(err);
              file.download((err, contents) => {
                assert.ifError(err);
                assert.strictEqual(contents.toString(), FILE_CONTENTS);
                done();
              });
            });
          });
        });

        it('should convert CSEK to KMS key', done => {
          const encryptionKey = crypto.randomBytes(32);

          const file = bucket.file('encrypted-file', {encryptionKey});

          file.save(FILE_CONTENTS, {resumable: false}, err => {
            assert.ifError(err);

            file.rotateEncryptionKey({kmsKeyName}, err => {
              assert.ifError(err);

              file.download((err, contents) => {
                assert.ifError(err);
                assert.strictEqual(contents.toString(), 'secret data');
                done();
              });
            });
          });
        });
      });

      describe('buckets', () => {
        let bucket;

        before(done => {
          bucket = storage.bucket(generateName(), {kmsKeyName});
          async.series(
              [
                function createBucket(next) {
                  bucket.create(next);
                },

                function setDefaultKmsKeyName(next) {
                  bucket.setMetadata(
                      {
                        encryption: {
                          defaultKmsKeyName: kmsKeyName,
                        },
                      },
                      next);
                },
              ],
              done);
        });

        after(done => {
          bucket.setMetadata(
              {
                encryption: null,
              },
              done);
        });

        it('should have set defaultKmsKeyName on created bucket', done => {
          bucket.getMetadata((err, metadata) => {
            assert.ifError(err);

            // Strip the project ID, as it could be the placeholder locally, but
            // the real value upstream.
            const projectIdRegExp = /^.+\/locations/;
            const actualKmsKeyName =
                metadata.encryption.defaultKmsKeyName.replace(
                    projectIdRegExp, '');
            const expectedKmsKeyName = kmsKeyName.replace(projectIdRegExp, '');

            assert.strictEqual(actualKmsKeyName, expectedKmsKeyName);

            done();
          });
        });

        it('should update the defaultKmsKeyName', done => {
          const cryptoKeyId = generateName();
          const newKmsKeyName = generateKmsKeyName(cryptoKeyId);

          createCryptoKey(cryptoKeyId, err => {
            assert.ifError(err);

            bucket.setMetadata(
                {
                  encryption: {
                    defaultKmsKeyName: newKmsKeyName,
                  },
                },
                done);
          });
        });

        it('should insert an object that inherits the kms key name', done => {
          const file = bucket.file('kms-encrypted-file');

          bucket.getMetadata((err, metadata) => {
            assert.ifError(err);

            const defaultKmsKeyName = metadata.encryption.defaultKmsKeyName;

            file.save(FILE_CONTENTS, {resumable: false}, err => {
              assert.ifError(err);

              // Strip the project ID, as it could be the placeholder locally,
              // but the real value upstream.
              const projectIdRegExp = /^.+\/locations/;
              const actualKmsKeyName =
                  file.metadata.kmsKeyName.replace(projectIdRegExp, '');
              let expectedKmsKeyName =
                  defaultKmsKeyName.replace(projectIdRegExp, '');

              // Upstream attaches a version.
              expectedKmsKeyName = `${expectedKmsKeyName}/cryptoKeyVersions/1`;

              assert.strictEqual(actualKmsKeyName, expectedKmsKeyName);

              done();
            });
          });
        });
      });
    });

    it('should copy an existing file', done => {
      const opts = {destination: 'CloudLogo'};
      bucket.upload(FILES.logo.path, opts, (err, file) => {
        assert.ifError(err);

        file.copy('CloudLogoCopy', (err, copiedFile) => {
          assert.ifError(err);
          async.parallel(
              [file.delete.bind(file), copiedFile.delete.bind(copiedFile)],
              done);
        });
      });
    });

    it('should copy a large file', done => {
      const otherBucket = storage.bucket(generateName());
      const file = bucket.file('Big');
      const copiedFile = otherBucket.file(file.name);

      async.series(
          [
            callback =>
                bucket.upload(FILES.logo.path, {destination: file}, callback),
            callback => {
              otherBucket.create(
                  {
                    location: 'ASIA-EAST1',
                    dra: true,
                  },
                  callback as InstanceResponseCallback);
            },
            callback =>
                file.copy(copiedFile, callback as InstanceResponseCallback)
          ],
          err => {
            assert.ifError(err);
            async.series(
                [
                  copiedFile.delete.bind(copiedFile),
                  otherBucket.delete.bind(otherBucket),
                  file.delete.bind(file),
                ],
                done);
          });
    });

    it('should copy to another bucket given a gs:// URL', done => {
      const opts = {destination: 'CloudLogo'};
      bucket.upload(FILES.logo.path, opts, (err, file) => {
        assert.ifError(err);

        const otherBucket = storage.bucket(generateName());
        otherBucket.create(err => {
          assert.ifError(err);

          const destPath = 'gs://' + otherBucket.name + '/CloudLogoCopy';
          file.copy(destPath, err => {
            assert.ifError(err);

            otherBucket.getFiles((err, files) => {
              assert.ifError(err);

              assert.strictEqual(files!.length, 1);
              const newFile = files![0];

              assert.strictEqual(newFile.name, 'CloudLogoCopy');

              done();
            });
          });
        });
      });
    });

    it('should allow changing the storage class', done => {
      const file = bucket.file(generateName());

      async.series(
          [
            next => {
              bucket.upload(FILES.logo.path, {destination: file}, next);
            },

            next => {
              file.setStorageClass('standard', next);
            },

            next => {
              file.getMetadata((err, metadata) => {
                assert.ifError(err);
                assert.strictEqual(metadata.storageClass, 'STANDARD');
                next();
              });
            },

            next => {
              file.setStorageClass('multi-regional', next);
            },
          ],
          err => {
            assert.ifError(err);

            file.getMetadata((err, metadata) => {
              assert.ifError(err);
              assert.strictEqual(metadata.storageClass, 'MULTI_REGIONAL');
              done();
            });
          });
    });
  });

  describe('channels', () => {
    it('should create a channel', done => {
      const config = {
        address: 'https://yahoo.com',
      };

      bucket.createChannel('new-channel', config, err => {
        // Actually creating a channel is pretty complicated. This will at least
        // let us know we hit the right endpoint and it received "yahoo.com".
        assert(err.message.includes(config.address));
        done();
      });
    });

    it('should stop a channel', done => {
      // We can't actually create a channel. But we can test to see that we're
      // reaching the right endpoint with the API request.
      const channel = storage.channel('id', 'resource-id');
      channel.stop(err => {
        assert.strictEqual((err as ApiError).code, 404);
        assert.strictEqual(err!.message.indexOf('Channel \'id\' not found'), 0);
        done();
      });
    });
  });

  describe('combine files', () => {
    it('should combine multiple files into one', done => {
      const files = [
        {file: bucket.file('file-one.txt'), contents: '123'},
        {file: bucket.file('file-two.txt'), contents: '456'},
      ];

      async.each(files, createFile, err => {
        assert.ifError(err);

        const sourceFiles = files.map(x => x.file);
        const destinationFile = bucket.file('file-one-and-two.txt');

        bucket.combine(sourceFiles, destinationFile, err => {
          assert.ifError(err);

          destinationFile.download((err, contents) => {
            assert.ifError(err);

            assert.strictEqual(
                contents.toString(), files.map(x => x.contents).join(''));

            async.each(sourceFiles.concat([destinationFile]), deleteFile, done);
          });
        });
      });

      function createFile(fileObject, callback) {
        fileObject.file.save(fileObject.contents, callback);
      }
    });
  });

  describe('list files', () => {
    const DIRECTORY_NAME = 'directory-name';

    const NEW_FILES = [
      bucket.file('CloudLogo1'),
      bucket.file('CloudLogo2'),
      bucket.file('CloudLogo3'),
      bucket.file(`${DIRECTORY_NAME}/CloudLogo4`),
      bucket.file(`${DIRECTORY_NAME}/CloudLogo5`),
      bucket.file(`${DIRECTORY_NAME}/inner/CloudLogo6`),
    ];

    before(done => {
      bucket.deleteFiles(err => {
        if (err) {
          done(err);
          return;
        }

        const originalFile = NEW_FILES[0];
        const cloneFiles = NEW_FILES.slice(1);

        bucket.upload(
            FILES.logo.path, {
              destination: originalFile,
            },
            err => {
              if (err) {
                done(err);
                return;
              }

              async.each(
                  cloneFiles, originalFile.copy.bind(originalFile), done);
            });
      });
    });

    after(done => {
      async.each(NEW_FILES, deleteFile, done);
    });

    it('should get files', done => {
      bucket.getFiles((err, files) => {
        assert.ifError(err);
        assert.strictEqual(files!.length, NEW_FILES.length);
        done();
      });
    });

    it('should get files as a stream', done => {
      let numFilesEmitted = 0;

      bucket.getFilesStream()
          .on('error', done)
          .on('data',
              () => {
                numFilesEmitted++;
              })
          .on('end', () => {
            assert.strictEqual(numFilesEmitted, NEW_FILES.length);
            done();
          });
    });

    it('should get files from a directory', done => {
      bucket.getFiles({directory: DIRECTORY_NAME}, (err, files) => {
        assert.ifError(err);
        assert.strictEqual(files!.length, 3);
        done();
      });
    });

    it('should get files from a directory as a stream', done => {
      let numFilesEmitted = 0;

      bucket.getFilesStream({directory: DIRECTORY_NAME})
          .on('error', done)
          .on('data',
              () => {
                numFilesEmitted++;
              })
          .on('end', () => {
            assert.strictEqual(numFilesEmitted, 3);
            done();
          });
    });

    it('should paginate the list', done => {
      const query = {
        maxResults: NEW_FILES.length - 1,
      };

      bucket.getFiles(query, (err, files, nextQuery) => {
        assert.ifError(err);
        assert.strictEqual(files!.length, NEW_FILES.length - 1);
        assert(nextQuery);
        bucket.getFiles(nextQuery!, (err, files) => {
          assert.ifError(err);
          assert.strictEqual(files!.length, 1);
          done();
        });
      });
    });
  });

  describe('file generations', () => {
    const bucketWithVersioning = storage.bucket(generateName());

    before(done => {
      bucketWithVersioning.create(
          {
            versioning: {
              enabled: true,
            },
          },
          done);
    });

    after(done => {
      bucketWithVersioning.deleteFiles(
          {
            versions: true,
          },
          err => {
            if (err) {
              done(err);
              return;
            }
            bucketWithVersioning.delete(done);
          });
    });

    it('should overwrite file, then get older version', done => {
      const versionedFile = bucketWithVersioning.file(generateName());

      versionedFile.save('a', err => {
        assert.ifError(err);

        versionedFile.getMetadata((err, metadata) => {
          assert.ifError(err);

          const initialGeneration = metadata.generation;

          versionedFile.save('b', err => {
            assert.ifError(err);

            const firstGenFile = bucketWithVersioning.file(versionedFile.name, {
              generation: initialGeneration,
            });

            firstGenFile.download((err, contents) => {
              assert.ifError(err);
              assert.strictEqual(contents.toString(), 'a');
              done();
            });
          });
        });
      });
    });

    it('should get all files scoped to their version', done => {
      const filesToCreate = [
        {file: bucketWithVersioning.file('file-one.txt'), contents: '123'},
        {file: bucketWithVersioning.file('file-one.txt'), contents: '456'},
      ];

      async.each(filesToCreate, createFile, err => {
        assert.ifError(err);

        bucketWithVersioning.getFiles({versions: true}, (err, files) => {
          assert.ifError(err);

          // same file.
          assert.strictEqual(files![0].name, files![1].name);

          // different generations.
          assert.notStrictEqual(
              files![0].metadata.generation, files![1].metadata.generation);

          done();
        });
      });

      function createFile(fileObject, callback) {
        fileObject.file.save(fileObject.contents, callback);
      }
    });
  });

  describe('sign urls', () => {
    const localFile = fs.readFileSync(FILES.logo.path);
    let file;

    before(done => {
      file = bucket.file('LogoToSign.jpg');
      fs.createReadStream(FILES.logo.path)
          .pipe(file.createWriteStream())
          .on('error', done)
          .on('finish', done.bind(null, null));
    });

    it('should create a signed read url', done => {
      file.getSignedUrl(
          {
            action: 'read',
            expires: Date.now() + 5000,
          },
          (err, signedReadUrl) => {
            assert.ifError(err);
            fetch(signedReadUrl)
                .then(res => res.text())
                .then(body => {
                  assert.strictEqual(body, localFile.toString());
                  file.delete(done);
                })
                .catch(error => assert.ifError(error));
          });
    });

    it('should create a signed delete url', done => {
      file.getSignedUrl(
          {
            action: 'delete',
            expires: Date.now() + 5000,
          },
          (err, signedDeleteUrl) => {
            assert.ifError(err);
            fetch(signedDeleteUrl, {method: 'DELETE'})
                .then(() => {
                  file.getMetadata(err => {
                    assert.strictEqual(err.code, 404);
                    done();
                  });
                })
                .catch(error => assert.ifError(error));
          });
    });
  });

  describe('sign policy', () => {
    let file;

    before(done => {
      file = bucket.file('LogoToSign.jpg');
      fs.createReadStream(FILES.logo.path)
          .pipe(file.createWriteStream())
          .on('error', done)
          .on('finish', done.bind(null, null));
    });

    beforeEach(function() {
      if (!storage.projectId) {
        this.skip();
      }
    });

    it('should create a policy', done => {
      const expires = new Date('10-25-2022');
      const expectedExpiration = new Date(expires).toISOString();

      const options = {
        equals: ['$Content-Type', 'image/jpeg'],
        expires,
        contentLengthRange: {
          min: 0,
          max: 1024,
        },
      };

      file.getSignedPolicy(options, (err, policy) => {
        assert.ifError(err);

        let policyJson;

        try {
          policyJson = JSON.parse(policy.string);
        } catch (e) {
          done(e);
          return;
        }

        assert.strictEqual(policyJson.expiration, expectedExpiration);
        done();
      });
    });
  });

  describe('notifications', () => {
    let notification;
    let subscription;

    before(() => {
      return bucket
          .createNotification(topic, {
            eventTypes: ['OBJECT_FINALIZE'],
          })
          .then(data => {
            notification = data[0];
            subscription = topic.subscription(generateName());

            return subscription.create();
          });
    });

    after(() => {
      return subscription.delete()
          .then(() => {
            return bucket.getNotifications();
          })
          .then(data => {
            return Promise.all(data[0].map(notification => {
              return notification.delete();
            }));
          });
    });

    it('should get an existing notification', done => {
      notification.get(err => {
        assert.ifError(err);
        assert(!is.empty(notification.metadata));
        done();
      });
    });

    it('should get a notifications metadata', done => {
      notification.getMetadata((err, metadata) => {
        assert.ifError(err);
        assert(is.object(metadata));
        done();
      });
    });

    it('should tell us if a notification exists', done => {
      notification.exists((err, exists) => {
        assert.ifError(err);
        assert(exists);
        done();
      });
    });

    it('should tell us if a notification does not exist', done => {
      const notification = bucket.notification('123');

      notification.exists((err, exists) => {
        assert.ifError(err);
        assert.strictEqual(exists, false);
        done();
      });
    });

    it('should get a list of notifications', done => {
      bucket.getNotifications((err, notifications) => {
        assert.ifError(err);
        assert.strictEqual(notifications!.length, 1);
        done();
      });
    });

    it('should emit events to a subscription', done => {
      subscription.on('error', done).on('message', message => {
        const attrs = message.attributes;
        assert.strictEqual(attrs.eventType, 'OBJECT_FINALIZE');
        done();
      });

      bucket.upload(FILES.logo.path, err => {
        if (err) {
          done(err);
        }
      });
    });

    it('should delete a notification', () => {
      let notificationCount = 0;
      let notification;

      return bucket
          .createNotification(topic, {
            eventTypes: ['OBJECT_DELETE'],
          })
          .then(data => {
            notification = data[0];
            return bucket.getNotifications();
          })
          .then(data => {
            notificationCount = data[0].length;
            return notification.delete();
          })
          .then(() => {
            return bucket.getNotifications();
          })
          .then(data => {
            assert.strictEqual(data[0].length, notificationCount - 1);
          });
    });
  });

  function deleteBucket(
      bucket: Bucket, options: {}, callback: DeleteBucketCallback): void;
  function deleteBucket(bucket: Bucket, callback: DeleteBucketCallback): void;
  function deleteBucket(
      bucket: Bucket, optsOrCb: {}|DeleteBucketCallback,
      callback?: DeleteBucketCallback) {
    let options = typeof optsOrCb === 'object' ? optsOrCb : {};
    callback = typeof optsOrCb === 'function' ?
        optsOrCb as DeleteBucketCallback :
        callback;

    // After files are deleted, eventual consistency may require a bit of a
    // delay to ensure that the bucket recognizes that the files don't exist
    // anymore.
    const CONSISTENCY_DELAY_MS = 250;

    options = extend({}, options, {
      versions: true,
    });

    bucket.deleteFiles(options, err => {
      if (err) {
        callback!(err as Error);
        return;
      }

      setTimeout(() => {
        bucket.delete(options, callback!);
      }, CONSISTENCY_DELAY_MS);
    });
  }

  function deleteFile(file, callback) {
    file.delete(callback);
  }

  function deleteTopic(topic, callback) {
    topic.delete(callback);
  }

  function generateName() {
    return TESTS_PREFIX + uuid.v1();
  }

  function deleteAllBuckets(callback) {
    storage.getBuckets(
        {
          prefix: TESTS_PREFIX,
        },
        (err, buckets) => {
          if (err) {
            callback(err);
            return;
          }
          async.eachLimit(buckets, 10, deleteBucket, callback);
        });
  }

  function deleteAllTopics(callback) {
    pubsub.getTopics((err, topics) => {
      if (err) {
        callback(err);
        return;
      }

      topics = topics.filter(topic => {
        return topic.name.indexOf(TESTS_PREFIX) > -1;
      });

      async.eachLimit(topics, 10, deleteTopic, callback);
    });
  }
});
