'use strict';

var Backbone = require('backbone'),
    AppSettingsModel = require('./app-settings-model'),
    MenuModel = require('./menu/menu-model'),
    EntryModel = require('./entry-model'),
    GroupModel = require('./group-model'),
    FileCollection = require('../collections/file-collection'),
    EntryCollection = require('../collections/entry-collection'),
    FileInfoCollection = require('../collections/file-info-collection'),
    FileModel = require('./file-model'),
    FileInfoModel = require('./file-info-model'),
    Storage = require('../storage'),
    Timeouts = require('../const/timeouts'),
    IdGenerator = require('../util/id-generator'),
    Logger = require('../util/logger'),
    FeatureDetector = require('../util/feature-detector');

require('../mixins/protected-value-ex');

var AppModel = Backbone.Model.extend({
    defaults: {},

    initialize: function() {
        this.tags = [];
        this.files = new FileCollection();
        this.fileInfos = FileInfoCollection.load();
        this.menu = new MenuModel();
        this.filter = {};
        this.sort = 'title';
        this.settings = AppSettingsModel.instance;
        this.activeEntryId = null;
        this.isBeta = FeatureDetector.isBeta();

        this.listenTo(Backbone, 'refresh', this.refresh);
        this.listenTo(Backbone, 'set-filter', this.setFilter);
        this.listenTo(Backbone, 'add-filter', this.addFilter);
        this.listenTo(Backbone, 'set-sort', this.setSort);
        this.listenTo(Backbone, 'empty-trash', this.emptyTrash);

        this.appLogger = new Logger('app');
    },

    addFile: function(file) {
        if (this.files.getById(file.id)) {
            return false;
        }
        this.files.add(file);
        file.get('groups').forEach(function (group) {
            this.menu.groupsSection.addItem(group);
        }, this);
        this._addTags(file);
        this._tagsChanged();
        this.menu.filesSection.addItem({
            icon: 'lock',
            title: file.get('name'),
            page: 'file',
            file: file
        });
        this.refresh();
        this.listenTo(file, 'reload', this.reloadFile);
        return true;
    },

    reloadFile: function(file) {
        this.menu.groupsSection.removeByFile(file, true);
        file.get('groups').forEach(function (group) {
            this.menu.groupsSection.addItem(group);
        }, this);
        this.updateTags();
    },

    _addTags: function(file) {
        var tagsHash = {};
        this.tags.forEach(function(tag) {
            tagsHash[tag.toLowerCase()] = true;
        });
        var that = this;
        file.forEachEntry({}, function(entry) {
            _.forEach(entry.tags, function(tag) {
                if (!tagsHash[tag.toLowerCase()]) {
                    tagsHash[tag.toLowerCase()] = true;
                    that.tags.push(tag);
                }
            });
        });
        this.tags.sort();
    },

    _tagsChanged: function() {
        if (this.tags.length) {
            this.menu.tagsSection.set('scrollable', true);
            this.menu.tagsSection.setItems(this.tags.map(function (tag) {
                return {title: tag, icon: 'tag', filterKey: 'tag', filterValue: tag};
            }));
        } else {
            this.menu.tagsSection.set('scrollable', false);
            this.menu.tagsSection.removeAllItems();
        }
    },

    updateTags: function() {
        var oldTags = this.tags.slice();
        this.tags.splice(0, this.tags.length);
        this.files.forEach(function(file) {
            this._addTags(file);
        }, this);
        if (!_.isEqual(oldTags, this.tags)) {
            this._tagsChanged();
        }
    },

    closeAllFiles: function() {
        var that = this;
        this.files.each(function(file) {
            file.close();
            that.fileClosed(file);
        });
        this.files.reset();
        this.menu.groupsSection.removeAllItems();
        this.menu.tagsSection.set('scrollable', false);
        this.menu.tagsSection.removeAllItems();
        this.menu.filesSection.removeAllItems();
        this.tags.splice(0, this.tags.length);
        this.filter = {};
        this.refresh();
    },

    closeFile: function(file) {
        file.close();
        this.fileClosed(file);
        this.files.remove(file);
        this.updateTags();
        this.menu.groupsSection.removeByFile(file);
        this.menu.filesSection.removeByFile(file);
        this.refresh();
    },

    emptyTrash: function() {
        this.files.forEach(function(file) {
            file.emptyTrash();
        }, this);
        this.refresh();
    },

    setFilter: function(filter) {
        this.filter = filter;
        this.filter.subGroups = this.settings.get('expandGroups');
        var entries = this.getEntries();
        if (!this.activeEntryId || !entries.get(this.activeEntryId)) {
            var firstEntry = entries.first();
            this.activeEntryId = firstEntry ? firstEntry.id : null;
        }
        Backbone.trigger('filter', { filter: this.filter, sort: this.sort, entries: entries });
        Backbone.trigger('select-entry', entries.get(this.activeEntryId));
    },

    refresh: function() {
        this.setFilter(this.filter);
    },

    addFilter: function(filter) {
        this.setFilter(_.extend(this.filter, filter));
    },

    setSort: function(sort) {
        this.sort = sort;
        this.setFilter(this.filter);
    },

    getEntries: function() {
        var entries = new EntryCollection();
        var filter = this.prepareFilter();
        this.files.forEach(function(file) {
            file.forEachEntry(filter, function(entry) {
                entries.push(entry);
            });
        });
        entries.sortEntries(this.sort);
        if (this.filter.trash) {
            this.addTrashGroups(entries);
        }
        return entries;
    },

    addTrashGroups: function(collection) {
        this.files.forEach(function(file) {
            var trashGroup = file.getTrashGroup();
            if (trashGroup) {
                trashGroup.getOwnSubGroups().forEach(function(group) {
                    collection.unshift(GroupModel.fromGroup(group, file, trashGroup));
                });
            }
        });
    },

    prepareFilter: function() {
        var filter = _.clone(this.filter);
        if (filter.text) {
            filter.textLower = filter.text.toLowerCase();
        }
        if (filter.tag) {
            filter.tagLower = filter.tag.toLowerCase();
        }
        return filter;
    },

    getFirstSelectedGroup: function() {
        var selGroupId = this.filter.group;
        var file, group;
        if (selGroupId) {
            this.files.forEach(function(f) {
                group = f.getGroup(selGroupId);
                if (group) {
                    file = f;
                    return false;
                }
            }, this);
        }
        if (!group) {
            file = this.files.first();
            group = file.get('groups').first();
        }
        return { group: group, file: file };
    },

    completeUserNames: function(part) {
        var userNames = {};
        this.files.forEach(function(file) {
            file.forEachEntry({ text: part, textLower: part.toLowerCase(), advanced: { user: true } }, function(entry) {
                var userName = entry.user;
                if (userName) {
                    userNames[userName] = (userNames[userName] || 0) + 1;
                }
            });
        });
        var matches = _.pairs(userNames);
        matches.sort(function(x, y) { return y[1] - x[1]; });
        var maxResults = 5;
        if (matches.length > maxResults) {
            matches.length = maxResults;
        }
        return matches.map(function(m) { return m[0]; });
    },

    createNewEntry: function() {
        var sel = this.getFirstSelectedGroup();
        return EntryModel.newEntry(sel.group, sel.file);
    },

    createNewGroup: function() {
        var sel = this.getFirstSelectedGroup();
        return GroupModel.newGroup(sel.group, sel.file);
    },

    createDemoFile: function() {
        var that = this;
        if (!this.files.getByName('Demo')) {
            var demoFile = new FileModel();
            demoFile.openDemo(function() {
                that.addFile(demoFile);
            });
            return true;
        } else {
            return false;
        }
    },

    createNewFile: function() {
        var name;
        for (var i = 0; ; i++) {
            name = 'New' + (i || '');
            if (!this.files.getByName(name) && !this.fileInfos.getByName(name)) {
                break;
            }
        }
        var newFile = new FileModel();
        newFile.create(name);
        this.addFile(newFile);
    },

    openFile: function(params, callback) {
        var logger = new Logger('open', params.name);
        logger.info('File open request');
        var that = this;
        var fileInfo = params.id ? this.fileInfos.get(params.id) : this.fileInfos.getMatch(params.storage, params.name, params.path);
        if (!params.opts && fileInfo && fileInfo.get('opts')) {
            params.opts = fileInfo.get('opts');
        }
        if (fileInfo && fileInfo.get('modified')) {
            logger.info('Open file from cache because it is modified');
            this.openFileFromCache(params, function(err, file) {
                if (!err && file) {
                    logger.info('Sync just opened modified file');
                    _.defer(that.syncFile.bind(that, file));
                }
                callback(err);
            }, fileInfo);
        } else if (params.fileData) {
            logger.info('Open file from supplied content');
            this.openFileWithData(params, callback, fileInfo, params.fileData, true);
        } else if (!params.storage) {
            logger.info('Open file from cache as main storage');
            this.openFileFromCache(params, callback, fileInfo);
        } else if (fileInfo && fileInfo.get('rev') === params.rev && fileInfo.get('storage') !== 'file') {
            logger.info('Open file from cache because it is latest');
            this.openFileFromCache(params, callback, fileInfo);
        } else if (!fileInfo || params.storage === 'file') {
            logger.info('Open file from storage', params.storage);
            var storage = Storage[params.storage];
            var storageLoad = function() {
                logger.info('Load from storage');
                storage.load(params.path, params.opts, function(err, data, stat) {
                    if (err) {
                        if (fileInfo) {
                            logger.info('Open file from cache because of storage load error', err);
                            that.openFileFromCache(params, callback, fileInfo);
                        } else {
                            logger.info('Storage load error', err);
                            callback(err);
                        }
                    } else {
                        logger.info('Open file from content loaded from storage');
                        params.fileData = data;
                        params.rev = stat && stat.rev || null;
                        that.openFileWithData(params, callback, fileInfo, data, true);
                    }
                });
            };
            var cacheRev = fileInfo && fileInfo.get('rev') || null;
            if (cacheRev && storage.stat) {
                logger.info('Stat file');
                storage.stat(params.path, params.opts, function(err, stat) {
                    if (fileInfo && (err || stat && stat.rev === cacheRev)) {
                        logger.info('Open file from cache because ' + (err ? 'stat error' : 'it is latest'), err);
                        that.openFileFromCache(params, callback, fileInfo);
                    } else if (stat) {
                        logger.info('Open file from storage (' + stat.rev + ', local ' + cacheRev + ')');
                        storageLoad();
                    } else {
                        logger.info('Stat error', err);
                        callback(err);
                    }
                });
            } else {
                storageLoad();
            }
        } else {
            logger.info('Open file from cache, after load will sync', params.storage);
            this.openFileFromCache(params, function(err, file) {
                if (!err && file) {
                    logger.info('Sync just opened file');
                    _.defer(that.syncFile.bind(that, file));
                }
                callback(err);
            }, fileInfo);
        }
    },

    openFileFromCache: function(params, callback, fileInfo) {
        var that = this;
        Storage.cache.load(fileInfo.id, null, function(err, data) {
            new Logger('open', params.name).info('Loaded file from cache', err);
            if (err) {
                callback(err);
            } else {
                that.openFileWithData(params, callback, fileInfo, data);
            }
        });
    },

    openFileWithData: function(params, callback, fileInfo, data, updateCacheOnSuccess) {
        var logger = new Logger('open', params.name);
        if (!params.keyFileData && fileInfo && fileInfo.get('keyFileName') && this.settings.get('rememberKeyFiles')) {
            params.keyFileName = fileInfo.get('keyFileName');
            params.keyFileData = FileModel.createKeyFileWithHash(fileInfo.get('keyFileHash'));
        }
        var file = new FileModel({
            name: params.name,
            storage: params.storage,
            path: params.path,
            keyFileName: params.keyFileName
        });
        var that = this;
        file.open(params.password, data, params.keyFileData, function(err) {
            if (err) {
                return callback(err);
            }
            if (that.files.get(file.id)) {
                return callback('Duplicate file id');
            }
            if (fileInfo && fileInfo.get('modified')) {
                if (fileInfo.get('editState')) {
                    logger.info('Loaded local edit state');
                    file.setLocalEditState(fileInfo.get('editState'));
                }
                logger.info('Mark file as modified');
                file.set('modified', true);
            }
            if (fileInfo) {
                file.set('syncDate', fileInfo.get('syncDate'));
            }
            var cacheId = fileInfo && fileInfo.id || IdGenerator.uuid();
            file.set('cacheId', cacheId);
            if (updateCacheOnSuccess) {
                logger.info('Save loaded file to cache');
                Storage.cache.save(cacheId, null, params.fileData);
            }
            var rev = params.rev || fileInfo && fileInfo.get('rev');
            that.setFileOpts(file, params.opts);
            that.addToLastOpenFiles(file, rev);
            that.addFile(file);
            that.fileOpened(file);
            callback(null, file);
        });
    },

    importFileWithXml: function(params, callback) {
        var logger = new Logger('import', params.name);
        logger.info('File import request with supplied xml');
        var file = new FileModel({
            name: params.name,
            storage: params.storage,
            path: params.path
        });
        var that = this;
        file.importWithXml(params.fileXml, function(err) {
            logger.info('Import xml complete ' + (err ? 'with error' : ''), err);
            if (err) {
                return callback(err);
            }
            that.addFile(file);
            that.fileOpened(file);
        });
    },

    addToLastOpenFiles: function(file, rev) {
        this.appLogger.debug('Add last open file', file.get('cacheId'), file.get('name'), file.get('storage'), file.get('path'), rev);
        var dt = new Date();
        var fileInfo = new FileInfoModel({
            id: file.get('cacheId'),
            name: file.get('name'),
            storage: file.get('storage'),
            path: file.get('path'),
            opts: this.getStoreOpts(file),
            modified: file.get('modified'),
            editState: file.getLocalEditState(),
            rev: rev,
            syncDate: file.get('syncDate') || dt,
            openDate: dt
        });
        if (this.settings.get('rememberKeyFiles')) {
            fileInfo.set({
                keyFileName: file.get('keyFileName') || null,
                keyFileHash: file.getKeyFileHash()
            });
        }
        this.fileInfos.remove(file.get('cacheId'));
        this.fileInfos.unshift(fileInfo);
        this.fileInfos.save();
    },

    getStoreOpts: function(file) {
        var opts = file.get('opts'), storage = file.get('storage');
        if (Storage[storage]&& Storage[storage].fileOptsToStoreOpts && opts) {
            return Storage[storage].fileOptsToStoreOpts(opts, file);
        }
        return null;
    },

    setFileOpts: function(file, opts) {
        var storage = file.get('storage');
        if (Storage[storage]&& Storage[storage].storeOptsToFileOpts && opts) {
            file.set('opts', Storage[storage].storeOptsToFileOpts(opts, file));
        }
    },

    fileOpened: function(file) {
        var that = this;
        if (file.get('storage') === 'file') {
            Storage.file.watch(file.get('path'), _.debounce(function() {
                that.syncFile(file);
            }, Timeouts.FileChangeSync));
        }
    },

    fileClosed: function(file) {
        if (file.get('storage') === 'file') {
            Storage.file.unwatch(file.get('path'));
        }
    },

    removeFileInfo: function(id) {
        Storage.cache.remove(id);
        this.fileInfos.remove(id);
        this.fileInfos.save();
    },

    getFileInfo: function(file) {
        return file.get('cacheId') ? this.fileInfos.get(file.get('cacheId')) :
            this.fileInfos.getMatch(file.get('storage'), file.get('name'), file.get('path'));
    },

    syncFile: function(file, options, callback) {
        var that = this;
        if (file.get('demo')) {
            return callback && callback();
        }
        if (file.get('syncing')) {
            return callback && callback('Sync in progress');
        }
        if (!options) {
            options = {};
        }
        var logger = new Logger('sync', file.get('name'));
        var storage = options.storage || file.get('storage');
        var path = options.path || file.get('path');
        var opts = options.opts || file.get('opts');
        if (storage && Storage[storage].getPathForName && (!path || storage !== file.get('storage'))) {
            path = Storage[storage].getPathForName(file.get('name'));
        }
        logger.info('Sync started', storage, path, options);
        var fileInfo = this.getFileInfo(file);
        if (!fileInfo) {
            logger.info('Create new file info');
            var dt = new Date();
            fileInfo = new FileInfoModel({
                id: IdGenerator.uuid(),
                name: file.get('name'),
                storage: file.get('storage'),
                path: file.get('path'),
                opts: this.getStoreOpts(file),
                modified: file.get('modified'),
                editState: null,
                rev: null,
                syncDate: dt,
                openDate: dt
            });
        }
        file.setSyncProgress();
        var complete = function(err, savedToCache) {
            if (!err) { savedToCache = true; }
            logger.info('Sync finished', err || 'no error');
            file.setSyncComplete(path, storage, err ? err.toString() : null, savedToCache);
            file.set('cacheId', fileInfo.id);
            fileInfo.set({
                name: file.get('name'),
                storage: storage,
                path: path,
                opts: that.getStoreOpts(file),
                modified: file.get('modified'),
                editState: file.getLocalEditState(),
                syncDate: file.get('syncDate'),
                cacheId: fileInfo.id
            });
            if (that.settings.get('rememberKeyFiles')) {
                fileInfo.set({
                    keyFileName: file.get('keyFileName') || null,
                    keyFileHash: file.getKeyFileHash()
                });
            }
            if (!that.fileInfos.get(fileInfo.id)) {
                that.fileInfos.unshift(fileInfo);
            }
            that.fileInfos.save();
            if (callback) { callback(err); }
        };
        if (!storage) {
            if (!file.get('modified') && fileInfo.id === file.get('cacheId')) {
                logger.info('Local, not modified');
                return complete();
            }
            logger.info('Local, save to cache');
            file.getData(function(data, err) {
                if (err) { return complete(err); }
                Storage.cache.save(fileInfo.id, null, data, function(err) {
                    logger.info('Saved to cache', err || 'no error');
                    complete(err);
                });
            });
        } else {
            var maxLoadLoops = 3, loadLoops = 0;
            var loadFromStorageAndMerge = function() {
                if (++loadLoops === maxLoadLoops) {
                    return complete('Too many load attempts');
                }
                logger.info('Load from storage, attempt ' + loadLoops);
                Storage[storage].load(path, opts, function(err, data, stat) {
                    logger.info('Load from storage', stat, err || 'no error');
                    if (err) { return complete(err); }
                    file.mergeOrUpdate(data, options.remoteKey, function(err) {
                        logger.info('Merge complete', err || 'no error');
                        that.refresh();
                        if (err) {
                            if (err.code === 'InvalidKey') {
                                logger.info('Remote key changed, request to enter new key');
                                Backbone.trigger('remote-key-changed', { file: file });
                            }
                            return complete(err);
                        }
                        if (stat && stat.rev) {
                            logger.info('Update rev in file info');
                            fileInfo.set('rev', stat.rev);
                        }
                        file.set('syncDate', new Date());
                        if (file.get('modified')) {
                            logger.info('Updated sync date, saving modified file to cache and storage');
                            saveToCacheAndStorage();
                        } else if (file.get('dirty')) {
                            logger.info('Saving not modified dirty file to cache');
                            Storage.cache.save(fileInfo.id, null, data, function (err) {
                                if (err) { return complete(err); }
                                file.set('dirty', false);
                                logger.info('Complete, remove dirty flag');
                                complete();
                            });
                        } else {
                            logger.info('Complete, no changes');
                            complete();
                        }
                    });
                });
            };
            var saveToCacheAndStorage = function() {
                logger.info('Save to cache and storage');
                file.getData(function(data, err) {
                    if (err) { return complete(err); }
                    if (!file.get('dirty')) {
                        logger.info('Save to storage, skip cache because not dirty');
                        saveToStorage(data);
                    } else {
                        logger.info('Saving to cache');
                        Storage.cache.save(fileInfo.id, null, data, function (err) {
                            if (err) { return complete(err); }
                            file.set('dirty', false);
                            logger.info('Saved to cache, saving to storage');
                            saveToStorage(data);
                        });
                    }
                });
            };
            var saveToStorage = function(data) {
                logger.info('Save data to storage');
                Storage[storage].save(path, opts, data, function(err, stat) {
                    if (err && err.revConflict) {
                        logger.info('Save rev conflict, reloading from storage');
                        loadFromStorageAndMerge();
                    } else if (err) {
                        logger.info('Error saving data to storage');
                        complete(err);
                    } else {
                        if (stat && stat.rev) {
                            logger.info('Update rev in file info');
                            fileInfo.set('rev', stat.rev);
                        }
                        if (stat && stat.path) {
                            logger.info('Update path in file info', stat.path);
                            file.set('path', stat.path);
                            fileInfo.set('path', stat.path);
                            path = stat.path;
                        }
                        file.set('syncDate', new Date());
                        logger.info('Save to storage complete, update sync date');
                        complete();
                    }
                }, fileInfo.get('rev'));
            };
            logger.info('Stat file');
            Storage[storage].stat(path, opts, function (err, stat) {
                if (err) {
                    if (err.notFound) {
                        logger.info('File does not exist in storage, creating');
                        saveToCacheAndStorage();
                    } else if (file.get('dirty')) {
                        logger.info('Stat error, dirty, save to cache', err || 'no error');
                        file.getData(function (data) {
                            if (data) {
                                Storage.cache.save(fileInfo.id, null, data, function (e) {
                                    if (!e) {
                                        file.set('dirty', false);
                                    }
                                    logger.info('Saved to cache, exit with error', err || 'no error');
                                    complete(err);
                                });
                            }
                        });
                    } else {
                        logger.info('Stat error, not dirty', err || 'no error');
                        complete(err);
                    }
                } else if (stat.rev === fileInfo.get('rev')) {
                    if (file.get('modified')) {
                        logger.info('Stat found same version, modified, saving to cache and storage');
                        saveToCacheAndStorage();
                    } else {
                        logger.info('Stat found same version, not modified');
                        complete();
                    }
                } else {
                    logger.info('Found new version, loading from storage');
                    loadFromStorageAndMerge();
                }
            });
        }
    },

    clearStoredKeyFiles: function() {
        this.fileInfos.each(function(fileInfo) {
            fileInfo.set({
                keyFileName: null,
                keyFileHash: null
            });
        });
        this.fileInfos.save();
    }
});

module.exports = AppModel;
