const express = require('express');
const app = express();
const server = require('http').Server(app);
const port = process.env.PORT || 3000;
const articleScraper = require('./articleScraper');
var fs = require('fs');
const io = require('socket.io')(server);
const path = require('path');
const amazonPaapi = require('amazon-paapi');
let uu = require('url-unshort')();
let urlCache = {};
let asinCache = {};
let connections = [];
let stopSignalSent = false;

server.listen(port, () => console.log(`Amazin' Link Checker app listening on port ${port}!`))

function getItemErrorName(errMsg) {
    let returnStr = "";
    if (errMsg === "InvalidParameterValue") {
        returnStr = "ITEM NOT IN API BUT MAY EXIST - check manually!";
    } else if (errMsg === "CommerceService.ItemNotAccessible") {
        returnStr = "DOG PAGE - fix this link!";
    } else {
        //uncaughtError
        returnStr = "Error retrieving item - check manually!";
    }
    return returnStr;
}

function sendToFront(completeURLData, id) {
    io.to(id).emit('serverDataReceived', completeURLData);
}

function sendScrapedURLCount(count) {
    io.emit('urlsScraped', count);
}

io.on('connection', function(socket) {
    console.log('a user connected: ', socket.id);
    connections.push(socket.id);

    socket.on('disconnect', function(socket) {
        let idx = connections.findIndex(i => socket.id === i);
        connections.splice(idx, 1);
    });

    socket.on('stopSignal', function(socket) {
        stopSignalSent = true;
    })

    socket.on('beginProcessing', async (url, socketID, awsID, awsSecret, awsTag, marketplace) => {

        const commonParameters = {
            'AccessKey': awsID,
            'SecretKey': awsSecret,
            'PartnerTag': awsTag,
            'PartnerType': 'Associates',
            'Marketplace': marketplace 
        };

        console.log("url: ", url);
        console.log("socketID: ", socketID);
        console.log("awsID: ", awsID);
        console.log("awsSecret: ", awsSecret);
        console.log("awsTag: ", awsTag);
        console.log("marketplace: ", marketplace);

        stopSignalSent = false;

        let urls = await articleScraper(url);

        console.log("urls count:", urls.length);

        sendScrapedURLCount(urls.length);
        /* The scraper returns an array of Amazon affiliate links from the user's blog article .
            This code visits each one and builds an object representing the data on the page, 
            and displays that data to the user.
        */

        let results = []; // also build an array of results to write to a file for offline testing

        /* Build an array of ASINs by processing each URL */
        urls.filter(u => u !== null && u !== undefined);

        let asins = await getAsins(urls);
        let uniqueAsins = [...new Set(asins)];

        console.log("asins array for Amazon:");
        console.log(uniqueAsins);
        console.log("there are " + uniqueAsins.length + "asins in the array");

        // now ask Amazon about these ASINs
        const requestParameters = {
            'ItemIds': uniqueAsins,
            'ItemIdType': 'ASIN',
            'Condition': 'New',
            'Resources': [
                'ItemInfo.Title',
                'Offers.Listings.Price'
            ]
        };

        amazonPaapi.GetItems(commonParameters, requestParameters)
            .then(data => {
                // now we can populate ASINCache with the information from Amazon about these ASINs
                // these ASINs are valid
                for (let i = 0; i < data.ItemsResult.Items.length; i++) {
                    let item = data.ItemsResult.Items[i];
                    asinCache[item.ASIN] = {
                        valid: true,
                        itemName: item.ItemInfo.Title.DisplayValue
                    }
                }

                // these ASINs are not valid, but the ASIN has to be extracted from the message: 
                /* "Errors": [
                    {
                    "__type": "com.amazon.paapi5#ErrorData",
                    "Code": "InvalidParameterValue",
                    "Message": "The ItemId B0077QSLXI provided in the request is invalid."
                    }
                ], */

                console.log(data.Errors);
                const extractedASINs = data.Errors.map((err) => {
                        const regexp = /[a-zA-Z0-9]{10}/;
                        const match = err.Message.match(regexp);
                        return match ? match[0] : null;
                       }).filter(i => i)

                extractedASINs.forEach((asin) => {
                    asinCache[asin] = {
                        valid: false,
                        itemName: 'Item not found - check link manually'
                    }
                });

                // now we know the status of all these asins, so let's feed the user's urls back to the front-end one by one
                // for each url on the user's blog post
                // create an object called urlData and send it to the socket 
                urls.forEach((urlData) => {
                    console.log(urlData);

                    let urlObj = {
                        urlText: urlData.urlText, // "click here to see it on amazon"
                        itemName: asinCache[urlCache[urlData.url].asin].itemName, // product title from amazon?
                        tag: urlCache[urlData.url].tag, // myassociateid-20
                        url: urlData.url, // http://amzn.to/1234XYZ or similar 
                        validOnAmazon: asinCache[urlCache[urlData.url].asin].valid // asinCache[ASIN]: true/false 
                    };
                
                    results.push(urlObj); // build a results array for file-writing purposes  
                    
                    sendToFront(urlObj, socketID);

                });
            })
            .catch(error => {
                // catch an error.
                console.log("CATCH - ERROR:");
                console.log(error);
                
            });
    });
});

app.use(function(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

app.use(express.static(path.join(__dirname, './public')));

app.get('/fetch-static-data', (req, res) => {
    fs.readFile('./results.json', 'utf8', function(err, data) {
        if (err) throw err;
        //io.emit('mandiTest', 'socket stuff: read in some json data!!');
        io.emit('staticDataReceived', JSON.parse(data));
        //console.log("Sending JSON data to front-end");
        //res.send(data);
    });
});

async function getAsins(urls) {
    let asins = [];

    for await (let urlData of urls) {

        let data = await extractASINAndTagFromURL(urlData.url);

        if (!urlCache[urlData.url]) {
            // make an entry for it in the cache 
            urlCache[urlData.url] = {
                itemName:"unprocessed",
                validOnAmazon:false,
                asin: data.asin,
                tag: data.tag,
            }
        }

        if (data.asin) {
            asins.push(data.asin);
            //console.log("ASIN: " + data.asin + " TAG: " + data.tag);
        } else {
            console.log(urlData.url + " does not have a valid ASIN");
        }
    }

    return asins;

};

async function extractASINAndTagFromURL(url) {
    let asin = '';
    let tag = 'no tag found';

    console.log("extracting ASIN and Tag from this url: ", url);
    const shortenedMatch = url.match(/http(s?):\/\/amzn.to\/([a-zA-Z0-9]+)/);
    const shortened = shortenedMatch ? shortenedMatch[0] : '';

    if (shortenedMatch) {
        console.log("shortenedMatch is true");
        // if this is a shortened URL, so we have to figure out where it goes 
        const longURL = await uu.expand(shortened);
            if (longURL) {
                //console.log(`Original URL is ${longURL}`);

                const tagRaw = longURL.match(/(tag=([A-Za-z0-9-]{3,}))/);
                tag = tagRaw[0].replace('tag=','');

                const asinMatch = longURL.match(/\/[A-Z0-9]{4,}\//);
                asin = asinMatch ? asinMatch[0].replace(/\//g, '') : '';
                //console.log("Shortened url processed, got this asin: ", asin);
            } else {
                console.log('This url can\'t be expanded');
            }
    } else {
        console.log("long url is true");
        // it's already a long URL 
        const tagRaw = url.match(/(tag=([A-Za-z0-9-]{3,}))/);
        tag = tagRaw[0].replace('tag=','');

        const asinMatch = url.match(/\/\w{8,}[A-Z0-9]/);
        let extractedAsin = asinMatch ? asinMatch[0] : '';
        asin = extractedAsin.replace('/', ''); // remove leading slash if exists
        //console.log("Long url processed, got this asin: ", asin);
    }
    
    return {asin, tag};
}