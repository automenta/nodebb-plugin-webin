'use strict';

var async = require('async'),
	request = require('request'),
	winston = require('winston'),
	cron = require('cron').CronJob,
	toMarkdown = require('to-markdown').toMarkdown,
	S = require('string'),
	topics = module.parent.require('./topics'),
	db = module.parent.require('./database'),
	user = module.parent.require('./user'),
	plugins = module.parent.require('./plugins');
		
//https://github.com/danmactough/node-feedparser
var	feedparser = require('feedparser'); 


var NAME = 'nodebb-plugin-webin'; //plugin name
var minPeriodMS = 60 * 1000;
var updateOnStartup = true;

(function (module) {

	var cronJobs = [];

	cronJobs.push(new cron('* * * * *', function () {
		updateFeeds();
	}, null, false));

	
	
	module.init = function (app, middleware, controllers) {

		app.get('/admin/plugins/webin', middleware.admin.buildHeader, renderAdmin);
		app.get('/api/admin/plugins/webin', renderAdmin);

		app.post('/api/admin/plugins/webin/save', save);
	};

	function renderAdmin(req, res, next) {
		admin.getFeeds(function (err, feeds) {
			if (err) {
				return next(err);
			}

			res.render('admin/plugins/webin', {
				feeds: feeds
			});
		});
	}

	function save(req, res, next) {
		deleteFeeds(function (err) {
			if (err) {
				return next(err);
			}

			if (!req.body.feeds) {
				return res.json({
					message: 'Feeds saved!'
				});
			}

			saveFeeds(req.body.feeds, function (err) {
				if (err) {
					return next(err);
				}
				res.json({
					message: 'Feeds saved!'
				});
			});
		});
	}

	function reStartCronJobs() {
		stopCronJobs();
		cronJobs.forEach(function (job) {
			job.start();
		});
		if (updateOnStartup)
			updateFeeds();		
	}

	function stopCronJobs() {
		cronJobs.forEach(function (job) {
			job.stop();
		});
	}

	function updateFeeds() {
		
		admin.getFeeds(function (err, feeds) {
			
			var now = Date.now();
			
			feeds = feeds.filter(function (item) {

				if (!item.lastUpdateTime)
					return true;
				else if (now - item.lastUpdateTime > item.interval*1000)
					return true;

				return false;
			});

			pullFeeds(feeds);
		});
	}

	plugins.isActive(NAME, function (err, active) {
		if (active) {
			reStartCronJobs();
		}
	});

	function pullFeeds(feeds) {

		var now = Date.now();
		
		function get(feed, next) {
			
			if (!feed.lastEntryDate) {
				feed.lastEntryDate = 0;
			}

			getRSS(feed.url, null, function (err, entries) {
				if (err) {
					return next(err);
				}

				if (!entries || !entries.length) {
					return next();
				}

				var mostRecent = feed.lastEntryDate;

				function post(posts) {
					user.getUidByUsername(feed.username, function (err, uid) {
						if (err) {
							return next(err);
						}

						if (!uid) {
							uid = 1;
						}

						for (var i = 0; i < posts.length; i++) {
							var entry = posts[i];
							
							//TODO add more metadata
							
							var topicData = {
								uid: uid,
								title: entry.title,
								content: toMarkdown(S(entry.content).stripTags('div', 'script', 'span')).s,
								cid: feed.category
							};

							topics.post(topicData, function (err) {
								if (err) {
									winston.error(err.message);
								}
							});
						}
					});
				}

				var entryDate;
				var posts = [];
				
				for (var i = 0; i < entries.length; ++i) {
					
					/*
					var maxlen = a['title'].length;
					if (a['description'] != undefined)
						maxlen = Math.max(maxlen, a['description'].length);

					var w;
					if (a['date'])
						w = new Date(a['date']).getTime();
					else
						w = Date.now();

					var x = $N.objNew($N.MD5(a['guid']), a['title']);
					x.createdAt = w;

					var desc = a['description'];
					if (desc && (desc.length > 0))
						$N.objAddDescription(x, desc);

					if (a['georss:point']) {
						var pp = a['georss:point'];
						if (pp.length === 2) {
							$N.objAddGeoLocation(x, pp[0], pp[1]);
						}
						else {
							pp = pp['#'].split(' ');
							$N.objAddGeoLocation(x, pp[0], pp[1]);
						}
						a.geolocation = [pp[0], pp[1]];
					}
					if (a['geo:lat']) {
						var lat = parseFloat(a['geo:lat']['#']);
						var lon = parseFloat(a['geo:long']['#']);
						$N.objAddGeoLocation(x, lat, lon);
						a.geolocation = [lat, lon];
					}
					$N.objAddTag(x, 'RSSItem');
					$N.objAddValue(x, 'rssItemURL', a['link']);
					*/
					
					var a = entries[i];
					var p = { };

					var w;
					if (a['date'])
						w = new Date(a['date']).getTime();
					else
						w = Date.now();
					
					entryDate = w;
					if (entryDate > feed.lastEntryDate) {
						feed.lastEntryDate = entryDate;
					}
					
					p.title = a.title;					
					p.content = a.description;
					
					posts.push(p);
				}
				
				if (posts.length > 0)
					post(posts);


				db.setObjectField(NAME + ':feed:' + feed.url, 'lastEntryDate', mostRecent);
				db.setObjectField(NAME + ':feed:' + feed.url, 'lastUpdateTime', now);

				next();
			});
		}


		async.each(feeds, get, function (err) {
			if (err) {
				winston.error(err.message);
			}
		});
	}

	var admin = {};

	admin.menu = function (custom_header, callback) {
		custom_header.plugins.push({
			route: '/plugins/webin',
			icon: 'fa-rss',
			name: 'Web Input'
		});

		callback(null, custom_header);
	};

	admin.getFeeds = function (callback) {
		db.getSetMembers(NAME + ':feeds', function (err, feedUrls) {

			if (err) {
				return callback(err);
			}

			function getFeed(feedUrl, next) {
				db.getObject(NAME + ':feed:' + feedUrl, next);
			}

			async.map(feedUrls, getFeed, function (err, results) {

				if (err) {
					return callback(err);
				}

				if (results) {
					callback(null, results);
				} else {
					callback(null, []);
				}
			});
		});
	};

	function saveFeeds(feeds, callback) {
		function saveFeed(feed, next) {
			if (!feed.url) {
				return next();
			}
			db.setObject(NAME + ':feed:' + feed.url, feed);
			db.setAdd(NAME + ':feeds', feed.url);
			next();
		}

		async.each(feeds, saveFeed, function (err) {
			callback(err);
		});
	}

	function deleteFeeds(callback) {
		db.getSetMembers(NAME + ':feeds', function (err, feeds) {
			if (err) {
				return callback(err);
			}

			if (!feeds) {
				return callback();
			}

			function deleteFeed(key, next) {
				db.delete(NAME + ':feed:' + key);
				db.setRemove(NAME + ':feeds', key);
				next();
			}

			async.each(feeds, deleteFeed, function (err) {
				callback(err);
			});

		});
	}

	admin.activate = function (id) {
		if (id === NAME) {
			reStartCronJobs();
		}
	};

	admin.deactivate = function (id) {
		if (id === NAME) {
			stopCronJobs();
		}
	};

	module.admin = admin;

}(module.exports));


var getRSS = function (url, perArticle, whenFinished /*, onlyItemsAfter*/ ) {

	if (!process)
		process = function (x) {
			return x;
		};

	var fp = new feedparser();

	var articles = [];
	
	request(url).pipe(fp)
		.on('error', function (error) {
			// always handle errors
			//console.log('RSS request error: ' + url + ' :' + error);
			whenFinished(error, null);			
		}).on('meta', function (data) {
			// always handle errors
			//onArticle(data);
			//console.log(data, 'META');
		}).on('readable', function () {
			var stream = this,
				item;
			while (item = stream.read()) {
				//console.log('Got article: %s', item.title || item.description);
				//onArticle(item);

				if (perArticle)
					item = perArticle(item);
				articles.push(item);
			}
		}).on('end', function () {
			if (whenFinished) {
				whenFinished(null, articles);
			}
		}).resume();

};

/*
function getFeedByGoogle(feedUrl, callback) {
	request('http://ajax.googleapis.com/ajax/services/feed/load?v=1.0&num=4&q=' + encodeURIComponent(feedUrl), function (err, response, body) {

		if (!err && response.statusCode === 200) {

			var p = JSON.parse(body);

			callback(null, p.responseData.feed.entries);
		} else {
			callback(err);
		}
	});
}
*/