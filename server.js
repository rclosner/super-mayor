var __              = require('lodash'),
    async           = require('async'),
    express         = require('express'),
    app             = module.exports = express.createServer(),
    io              = require('socket.io').listen(app),
    PORT            = process.env.PORT || 3000,
    cron            = require('cron'),
    Open311         = require('open311'),
    chicago         = new Open311('chicago'), // Configure the Open311 endpoint
    REFRESHMIN      = 2, // refresh things every how many minutes
    LASTUPDATED     = new Date(), // when this was last updated
    cachedRequests  = [], // a holder for all our requests
    MAXCACHE        = 100,// maximum number of requests to cache
    prevEmit        = new Date(0); // the last time we emitted something
    

/** Express Configuration **/
app.configure(function(){
  app.set('views', __dirname + '/views');
  app.set('view engine', 'ejs');
  app.use(express.bodyParser());
  app.use(express.methodOverride());
  app.use(express.compress());
  app.use(app.router);
  app.use(express.static(__dirname + '/public'));
});

app.configure('development', function(){
  app.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
});

app.configure('production', function(){
  app.use(express.errorHandler());
  io.set('log level', 1); // reduce logging
});


// Get requests from the last hour on startup
LASTUPDATED = new Date(LASTUPDATED.getTime() - 60*60*1000);
getRequests(LASTUPDATED);

//
// CRON FUNCTION
//
new cron.CronJob('0 */' + REFRESHMIN + ' * * * *', function(){
  getRequests(LASTUPDATED);
}, null, // no function to call when finished
  true // Start the job right now
);

function getRequests(lastUpdated) {
  chicago.serviceRequests({
    "updated_after": lastUpdated.toISOString(),
    "extensions": "true"
  }, function(err, data) {
    if (err) { console.log('Error retrieving request:', err); return; }
      
    console.log("Retrieved %d service requests at %s", data.length, LASTUPDATED.toISOString());
      
    if (data.length === 0) { return; }

    var requests = __.chain(data)       // Underscore chaining!
      .reject(function(request) {       // Remove any requests that don't have service_request_id's
        if (typeof request['service_request_id'] === 'undefined') {
          return true;
        }
        return false;
      })
      .sortBy('updated_datetime')       // Sort by updated_datetime
      .value();                         // and complete the chain
      
    // emit the requests
    normalizedEmit(requests);
  });
    
  // Update when we last updated
  lastUpdated = new Date();
}


/**
 * Take a collection of requests and emit them over a period of time
 *
 */
function normalizedEmit(requests) {
  var MINDELAY = 1300; // minimum time between emits
  
  async.forEachSeries(requests, function(request, done) {
    var expectedEmit = new Date(request['updated_datetime'].getTime() + (REFRESHMIN * 60000));
    
    // check if expectedEmit falls before our Minimum Delay; if so, set it to our minimum delay
    if (expectedEmit.getTime() < prevEmit.getTime() + MINDELAY) {
      expectedEmit = new Date(prevEmit.getTime() + MINDELAY)
    }
    
    // save the emit time for our next loop
    prevEmit = expectedEmit;
    console.log('Expect to emit Service Reqeuest #%s at %s', request.service_request_id, expectedEmit);
    
    setTimeout(function() {
      // log it
      console.log('Emitting Service Request #%s at %s', request.service_request_id, (new Date).toISOString());
      
      // broadcast globally
      io.sockets.emit("new-request", request);
    
      // // broadcast to an individual ward channel
      // if ( (typeof request['extended_attributes'] !== 'undefined') && 
      //      (typeof request['extended_attributes'].ward !== 'undefined')
      //    ) {
      //   io.sockets.in("ward-" + request['extended_attributes'].ward).emit("request", request);
      // }
      
      // Add them to our big object of cached requests      
      // if it already exists, remove it
      cachedRequests = __.reject(cachedRequests, function(cachedRequest) {
        if (cachedRequest['service_request_id'] === request['service_request_id']) {
          return true;
        }
        return false;
      });
      cachedRequests.unshift(request);
      
      // ensure that we don't cache too many requests
      if (cachedRequests.length >= MAXCACHE ) {
        cachedRequests.pop();
      }
    }, expectedEmit.getTime() - (new Date).getTime() );
   
   done(); 
  });
}

// assuming io is the Socket.IO server object
io.configure(function () { 
  io.set("transports", ["xhr-polling"]); 
  io.set("polling duration", 10); 
});

io.sockets.on('connection', function (socket) {
  socket.emit('existing-requests', cachedRequests); // send all of our requests on the first connection
});

app.listen(PORT, function(){
  console.log("Express server listening on port %d in %s mode", app.address().port, app.settings.env);
});