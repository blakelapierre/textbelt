var express = require('express')
  , bodyParser = require('body-parser')
  , app = express()
  , _ = require('underscore')
  , fs = require('fs')
  , exec = require('child_process').exec
  , spawn = require('child_process').spawn
  , Stream = require('stream')
  , providers = require('./providers.js')
  , nodemailer = require('nodemailer');

var mpq = {track: function() {}};

var redis = (function() {
  var store = {};

  return {
    incr: function(key, callback) {
      store[key] = (store[key] || 0) + 1;
      if (callback) callback(null, store[key]); 
    },
    decr: function(key, callback) {
      store[key] = (store[key] || 0) - 1;
      if (callback) callback(null, store[key]);
    }
  };
})();

// Express config
app.set('views', __dirname + '/views');
app.set('view engine', 'jade');

app.use(express.static(__dirname + '/public'));
app.use(express.bodyParser());

// App

/* Homepage */
app.get('/', function(req, res) {
  fs.readFile(__dirname + '/views/index.html', 'utf8', function(err, text){
    res.send(text);
  });
});

app.get('/providers/us', function(req, res) {
  res.send(providers.us);
});

app.post('/text', function(req, res) {
  var number = stripPhone(req.body.number);
  if (number.length < 9 || number.length > 10) {
    res.send({success:false,message:'Invalid phone number.'});
    return;
  }
  textRequestHandler(req, res, number, 'us');
});

app.post('/canada', function(req, res) {
  textRequestHandler(req, res, stripPhone(req.body.number), 'canada');
});

app.post('/intl', function(req, res) {
  textRequestHandler(req, res, stripPhone(req.body.number), 'intl');
});

function textRequestHandler(req, res, number, region) {
  if (!req.body.number || !req.body.message) {
    mpq.track('incomplete request');
    res.send({success:false,message:'Number and message parameters are required.'});
    return;
  }
  var ip = req.header('X-Real-IP');// || req.connection.remoteAddress;
  mpq.track('textRequestHandler entry', {number: req.body.number, message: req.body.message, ip: ip, region: region});

  var message = req.body.message;
  if (message.indexOf('http') === 0) {
    message = ' ' + message;
  }

  var ipkey = 'textbelt:ip:' + ip + '_' + dateStr();
  var phonekey = 'textbelt:phone:' + number;

  redis.incr(phonekey, function(err, num) {
    if (err) {
      mpq.track('redis fail');
      res.send({success:false,message:'Could not validate phone# quota.'});
      return;
    }

    setTimeout(function() {
      redis.decr(phonekey, function(err, num) {
        if (err) {
          mpq.track('failed to decr phone quota', {number: number});
          console.log('*** WARNING failed to decr ' + number);
        }
      });
    }, 1000*60*3);
    if (num > 3) {
      mpq.track('exceeded phone quota');
      res.send({success:false,message:'Exceeded quota for this phone number. ' + number});
      return;
    }

    // now check against ip quota
    redis.incr(ipkey, function(err, num) {
      if (err) {
        mpq.track('redis fail');
        res.send({success:false,message:'Could not validate IP quota.'});
        return;
      }
      if (num > 75) {
        mpq.track('exceeded ip quota');
        res.send({success:false,message:'Exceeded quota for this IP address. ' + ip});
        return;
      }
      setTimeout(function() {
        redis.decr(ipkey, function(err, num) {
          if (err) {
            mpq.track('failed to decr ip key', {ipkey: ipkey});
            console.log('*** WARNING failed to decr ' + ipkey);
          }
        });
      }, 1000*60*60*24);

      sendText(req.body.number, message, region, function(err) {
        if (err) {
          mpq.track('sendText failed', {number: req.body.number, message: req.body.message, ip: ip});
          res.send({success:false,message:'Communication with SMS gateway failed.'});
        }
        else {
          mpq.track('sendText success', {number: req.body.number, message: req.body.message, ip: ip, region: region});
          res.send({success:true});
        }
      });
    });

  });

}

function dateStr() {
  var today = new Date();
  var dd = today.getDate();
  var mm = today.getMonth()+1;
  var yyyy = today.getFullYear();
  return mm + '/' + dd + '/' + yyyy;
}

function stripPhone(phone) {
  return (phone+'').replace(/\D/g, '');
}

var mailer = nodemailer.createTransport('SMTP', {
  host: 'mail.facerace.in',
  port: 587,
  auth: {
    user: 'you.are.invited@facerace.in',
    pass: 'palebluedot'
  }
});

function sendText(phone, message, region, cb) {
  console.log('txting phone', phone, ':', message);

  region = region || 'us';

  var providers_list = providers[region];

  mailer.sendMail({
    from: 'you.are.invited@facerace.in',
    bcc: _.map(providers_list, function(provider) { return provider.replace('%s', phone); }),
    subject: message
  }, function(error, responseStatus) {
    if (error) console.log(arguments);
    cb(false);
  });
}

var port = process.env.PORT || 9090;
app.listen(port, function() {
  console.log('Listening on', port);
});
