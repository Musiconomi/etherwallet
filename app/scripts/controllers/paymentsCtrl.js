'use strict';
var paymentsCtrl = function ($scope, $sce, $http, walletService) {
  $scope.ajaxReq = ajaxReq;
  walletService.wallet = null;
  $scope.isApprovedDomain = true; // TODO

  $scope.Validator = Validator;
  $scope.tx = {
    gasLimit: '',
    data: '',
    to: '',
    unit: "ether",
    value: 0,
    nonce: null,
    gasPrice: '0x02cb417800'
  };

  $scope.contract = {
    address: '',
    abi: '',
    functions: [],
    selectedFunc: null
  };

  var paymentGatewayHost = 'https://musiconomi-pay.appspot.com';
  // var paymentGatewayHost = 'http://localhost:3000';
  $scope.network = 'ropsten';
  $scope.tokenContractAbi = '[{"constant":false,"inputs":[{"name":"_spender","type":"address"},{"name":"_value","type":"uint256"},{"name":"_extraData","type":"bytes"}],"name":"approveAndCall","outputs":[{"name":"success","type":"bool"}],"payable":false,"stateMutability":"nonpayable","type":"function"}]';
  $scope.invoiceId = globalFuncs.urlGet("invoice");

  $scope.fetchPaymentDetailsError = null;
  $scope.fetchStatus = "loading";

  var getPaymentDetails = function(invoiceId, callback) {
    // Get the details for this invoice
    $http.get(`${paymentGatewayHost}/invoice/${invoiceId}`)
      .then(function(response) {
        var orderInfo = response.data;
        var successUrl = (orderInfo.merchant.successUrl || orderInfo.merchant.website).replace("[[invoiceId]]", invoiceId);
        var failureUrl = (orderInfo.merchant.failureUrl || orderInfo.merchant.website).replace("[[invoiceId]]", invoiceId);
        var detailsUrl = (orderInfo.merchant.orderDetailsUrl || orderInfo.merchant.website).replace("[[invoiceId]]", invoiceId);

        callback(null, {
          tokenAddress: orderInfo.tokenAddress,
          tokenSymbol: orderInfo.baseCurrency,
          recipient: orderInfo.paymentContractAddress,
          recipientName: orderInfo.merchant.name,
          recipientUrl: orderInfo.merchant.website,
          invoiceTotal: new BigNumber(orderInfo.baseAmount).div(new BigNumber(10).pow(18)).toFormat(2),
          totalPaid: new BigNumber(orderInfo.totalPaid).div(new BigNumber(10).pow(18)).toFormat(2),
          approveAmount: new BigNumber(orderInfo.totalOwed).div(new BigNumber(10).pow(18)).toFormat(2),
          partiallyPaid: new BigNumber(orderInfo.totalOwed).lt(orderInfo.baseAmount),
          approveAmountGrains: new BigNumber(orderInfo.totalOwed),
          requiredConfirmations: orderInfo.requiredConfirmations,
          transactions: orderInfo.transactions,
          requiredGas: 125450,
          paidInFull: orderInfo.paidInFull,
          successUrl, failureUrl, detailsUrl
        });
        if (!$scope.$$phase) $scope.$apply();
      })
  };

  $scope.$watch(function () {
    if (walletService.wallet == null) return null;
    return walletService.wallet.getAddressString();
  }, function () {
    if (walletService.wallet == null) return;
    $scope.wallet = walletService.wallet;
    $scope.wd = true;
    $scope.tx.nonce = 0;

    $scope.generateTx(function(err) {
      if (!err) {
        console.log("rawTx", $scope.rawTx);
        $scope.sendTx(function(err, tx) {
          if (err) return console.log(err);
          $scope.monitorTransaction(tx, $scope.invoiceId);
        });
      }
      else {
        console.log(err);
      }
    })
  });

  $scope.$watch('tx', function(newValue, oldValue) {
    if (newValue.gasLimit == oldValue.gasLimit && $scope.Validator.isValidHex($scope.tx.data) && $scope.tx.data != '' && $scope.Validator.isPositiveNumber($scope.tx.value)) {
      if ($scope.estimateTimer) clearTimeout($scope.estimateTimer);
      $scope.estimateTimer = setTimeout(function() {
        $scope.estimateGasLimit();
      }, 50);
    }
  }, true);

  $scope.monitorTransactionOnce = function(txHash, invoiceId, cb) {
    var txUrl = `https://api.infura.io/v1/jsonrpc/${$scope.network}/eth_getTransactionReceipt?params=[%22${txHash}%22]`;
    if (!$scope.waitingForConfirmations) {
      console.log("Checking for tx", txHash);
      $http.get(txUrl)
        .then(function(response) {
          console.log("Got txReceipt response", response);
          var txReceipt = response.data.result;
          if (txReceipt) {
            console.log("Got txReceipt", txReceipt);
            if (txReceipt.status === "0x1") {
              console.log("Got txReceipt, success.  Waiting for gateway to confirm");
              $scope.waitingForConfirmations = true;
              $scope.txBlockNumber = ethFuncs.hexToDecimal(txReceipt.blockNumber);
              $scope.txConfirmations = 0;
              cb(null, null);
            }
            else {
              console.log("Got txReceipt, failed");
              $scope.txFailed = true;
              cb(new Error("Transaction failed"), null);
            }
          }
          else {
            console.log("No txReceipt, still waiting");
            cb(null, null);
          }
        })
        .catch(err => {
          cb(err, null);
        })
    }
    else {
      console.log("Checking for payment gateway confirmation", invoiceId);
      getPaymentDetails(invoiceId, function(err, result) {
        $scope.paymentDetails = result;
        cb(err, result);
      })

      var blockUrl = `https://api.infura.io/v1/jsonrpc/${$scope.network}/eth_blockNumber`;
      $http.get(blockUrl)
        .then(function(response) {
          $scope.currentBlockNumber = ethFuncs.hexToDecimal(response.data.result);
          $scope.txConfirmations = $scope.currentBlockNumber - $scope.txBlockNumber;
        })
    }
  };

  $scope.monitorTransaction = function(tx, invoiceId) {
    console.log(`Checking on tx ${tx} ${invoiceId}`);
    $scope.monitorTransactionOnce(tx, invoiceId, function(err, result) {
      var checkAgain = true;
      if (err) {
        console.log("An error occurred while checking on the tx", err);
        // if we know the transaction failed, stop polling
        if ($scope.txFailed) {
          console.log("Transaction failed");
          console.log("Stop polling", "Transaction failed");
          checkAgain = false;
        }
      }
      else if (result) {
        console.log("Got Result", result);
        if (result.paidInFull) {
          console.log("Stop polling", "Paid in full");
          checkAgain = false;
          setTimeout(function() {
            window.location = $scope.paymentDetails.successUrl;
          }, 3000);
        } else if (result.transactions && result.transactions.includes($scope.txHash)) {
          // the payment service knows about this tx, not need to keep checking
          console.log("Stop polling", "Payment gateway found the tx");
          checkAgain = false;
        }
      }
      else {
        console.log("Didn't get any result, still waiting for the tx");
      }

      console.log(checkAgain ? "Will check again in 5 sec" : "Done checking");
      if (checkAgain) {
        setTimeout(function() {
          $scope.monitorTransaction(tx, invoiceId);
        }, 5000);
      }
    });
  };

  $scope.estimateGasLimit = function () {
    var estObj = {
      from: $scope.wallet != null ? $scope.wallet.getAddressString() : globalFuncs.donateAddress,
      value: ethFuncs.sanitizeHex(ethFuncs.decimalToHex(etherUnits.toWei($scope.tx.value, $scope.tx.unit))),
      data: ethFuncs.sanitizeHex($scope.tx.data),
    }
    if ($scope.tx.to != '') estObj.to = $scope.tx.to;
    ethFuncs.estimateGas(estObj, function (data) {
      if (!data.error) $scope.tx.gasLimit = data.data;
    });
  };

  $scope.generateTx = function (callback) {
    try {
      if ($scope.wallet == null) throw globalFuncs.errorMsgs[3];
      else if (!ethFuncs.validateHexString($scope.tx.data)) throw globalFuncs.errorMsgs[9];
      else if (!globalFuncs.isNumeric($scope.tx.gasLimit) || parseFloat($scope.tx.gasLimit) <= 0) throw globalFuncs.errorMsgs[8];
      $scope.tx.data = ethFuncs.sanitizeHex($scope.tx.data);
      ajaxReq.getTransactionData($scope.wallet.getAddressString(), function (data) {
        if (data.error) $scope.notifier.danger(data.msg);
        if ($scope.tx.to == '') throw new Error("Message my have a to field");
        var txData = uiFuncs.getTxData($scope);
        uiFuncs.generateTx(txData, function (rawTx) {
          if (!rawTx.isError) {
            $scope.rawTx = rawTx.rawTx;
            $scope.signedTx = rawTx.signedTx;
            callback(null);
          } else {
            $scope.notifier.danger(rawTx.error);
            callback(rawTx.error);
          }
          if (!$scope.$$phase) $scope.$apply();
        });
      });
    } catch (e) {
      $scope.notifier.danger(e);
    }
  };

  $scope.sendTx = function (cb) {
    uiFuncs.sendTx($scope.signedTx, function (resp) {
      if (!resp.isError) {
        $scope.txHash = resp.data;
        $scope.txLink = $scope.ajaxReq.blockExplorerTX.replace("[[txHash]]", resp.data);
        $scope.notifier.success(globalFuncs.successMsgs[2] + "<br />" + resp.data + "<br />");
        if (cb) cb(null, $scope.txHash);
      } else {
        consle.log(resp.error);
        $scope.notifier.danger(resp.error);
        if (cb) cb(resp.error, null);
      }
    });
  };

  $scope.selectFunc = function (index) {
    $scope.contract.selectedFunc = {name: $scope.contract.functions[index].name, index: index};
    if (!$scope.contract.functions[index].inputs.length) {
      $scope.readFromContract();
      $scope.showRead = false;
    } else $scope.showRead = true;
  };

  $scope.getTxDataWithValues = function (values) {
    var curFunc = $scope.contract.functions[$scope.contract.selectedFunc.index];
    var fullFuncName = ethUtil.solidityUtils.transformToFullName(curFunc);
    var funcSig = ethFuncs.getFunctionSignature(fullFuncName);
    var typeName = ethUtil.solidityUtils.extractTypeName(fullFuncName);
    var types = typeName.split(',');
    types = types[0] == "" ? [] : types;
    return '0x' + funcSig + ethUtil.solidityCoder.encodeParams(types, values);
  };

  $scope.initContract = function () {
    try {
      if (!$scope.Validator.isValidAddress($scope.contract.address)) throw globalFuncs.errorMsgs[5];
      else if (!$scope.Validator.isJSON($scope.contract.abi)) throw globalFuncs.errorMsgs[26];
      $scope.contract.functions = [];
      var tAbi = JSON.parse($scope.contract.abi);
      for (var i in tAbi)
        if (tAbi[i].type == "function") {
          tAbi[i].inputs.map(function (i) {
            i.value = '';
          });
          $scope.contract.functions.push(tAbi[i]);
        }
    } catch (e) {
      $scope.notifier.danger(e);
    }
  };

  $scope.updatePaymentDetails = function() {

  };

  $scope.initializeMusiconomiDefaults = function () {
    ethFuncs.gasAdjustment = 12;
    $scope.contract.abi = $scope.tokenContractAbi;
    // var response = JSON.parse('{"jsonrpc":"2.0","id":1,"result":{"blockHash":"0xdad9b1b3b4fe4f10622427e7f43469ba11d007ff42fce2f4e0cdbeaf6fb36874","blockNumber":"0x55c571","contractAddress":null,"cumulativeGasUsed":"0x758221","from":"0x9dbc1f531ef143cc820afd4aca4f872b66b14095","gasUsed":"0x112f1","logs":[{"address":"0x138a8752093f4f9a79aaedf48d4b9248fab93c9c","topics":["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925","0x0000000000000000000000009dbc1f531ef143cc820afd4aca4f872b66b14095","0x0000000000000000000000005e1cdd970e60dce16ced2645f5fb71cfd22080cf"],"data":"0x0000000000000000000000000000000000000000000000000de0b6b3a7640000","blockNumber":"0x55c571","transactionHash":"0x2a6898daab73829b94d63ebe719a2e77b1759fd71919ba6bde3374e87f7b395b","transactionIndex":"0x6f","blockHash":"0xdad9b1b3b4fe4f10622427e7f43469ba11d007ff42fce2f4e0cdbeaf6fb36874","logIndex":"0xa0","removed":false},{"address":"0x138a8752093f4f9a79aaedf48d4b9248fab93c9c","topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x0000000000000000000000009dbc1f531ef143cc820afd4aca4f872b66b14095","0x0000000000000000000000009dbc1f531ef143cc820afd4aca4f872b66b14095"],"data":"0x0000000000000000000000000000000000000000000000000de0b6b3a7640000","blockNumber":"0x55c571","transactionHash":"0x2a6898daab73829b94d63ebe719a2e77b1759fd71919ba6bde3374e87f7b395b","transactionIndex":"0x6f","blockHash":"0xdad9b1b3b4fe4f10622427e7f43469ba11d007ff42fce2f4e0cdbeaf6fb36874","logIndex":"0xa1","removed":false},{"address":"0x5e1cdd970e60dce16ced2645f5fb71cfd22080cf","topics":["0xc412606d1453ef10430036588d3310fa96141c60c2f5966e17d55cc621b4a27b"],"data":"0x0000000000000000000000009dbc1f531ef143cc820afd4aca4f872b66b140950000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000d64656164626565663132333435","blockNumber":"0x55c571","transactionHash":"0x2a6898daab73829b94d63ebe719a2e77b1759fd71919ba6bde3374e87f7b395b","transactionIndex":"0x6f","blockHash":"0xdad9b1b3b4fe4f10622427e7f43469ba11d007ff42fce2f4e0cdbeaf6fb36874","logIndex":"0xa2","removed":false}],"logsBloom":"0x00000000000000000000000000000000000010000000000000000000080000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000008000000100000000000000000000000000000000000000000200000000040000000000000000000000000000000000010000000000010000000000000000000000000000000000000000000010010000000000000020000000000000000000000000000002000000000000000000000000000000000000012000000000000000000000000010001000000000000000000000000000010000000000000000000000000000000000000040000000000000000002100","status":"0x1","to":"0x138a8752093f4f9a79aaedf48d4b9248fab93c9c","transactionHash":"0x2a6898daab73829b94d63ebe719a2e77b1759fd71919ba6bde3374e87f7b395b","transactionIndex":"0x6f"}}')
    getPaymentDetails($scope.invoiceId, function(err, result) {
      if (err) {
        $scope.fetchStatus = "failed";
        $scope.fetchPaymentDetailsError = err;
      }
      else {
        $scope.fetchStatus = "success";
        $scope.paymentDetails = result;
        $scope.contract.address = $scope.paymentDetails.tokenAddress;
        $scope.tx.to = $scope.contract.address;
        $scope.initContract();
        $scope.selectFunc(0);

        $scope.tx.data = $scope.getTxDataWithValues([$scope.paymentDetails.recipient, $scope.paymentDetails.approveAmountGrains, $scope.invoiceId]);
        $scope.tx.gasLimit = $scope.paymentDetails.requiredGas;
      }
    })
  };
  $scope.initializeMusiconomiDefaults();
};
module.exports = paymentsCtrl;
