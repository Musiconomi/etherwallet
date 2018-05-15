'use strict';
var paymentsCtrl = function ($scope, $sce, walletService) {
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

  $scope.tokenContractAbi = '[{"constant":false,"inputs":[{"name":"_spender","type":"address"},{"name":"_value","type":"uint256"},{"name":"_extraData","type":"bytes"}],"name":"approveAndCall","outputs":[{"name":"success","type":"bool"}],"payable":false,"stateMutability":"nonpayable","type":"function"}]';
  $scope.tokenContract = '0x138A8752093F4f9a79AaeDF48d4B9248fab93c9C';
  $scope.orderId = 'deadbeef12345';
  $scope.tokenSymbol = 'MCI';

  $scope.fetchPaymentDetailsError = null;
  $scope.fetchStatus = "loading";
  $scope.confirmedAmount = false;

  var getPaymentDetails = function(orderId, callback) {
    // simulating request
    setTimeout(() => {
      callback(null, {
        recipient: '0x9DBc1F531ef143cc820afD4acA4F872b66B14095',
        recipientName: 'Musiconomi',
        recipientUrl: 'https://musiconomi.com',
        approveAmount: 10,
        approveAmountGrains: 12345,
        requiredGas: 30000
      });
      $scope.$apply();
    }, 2000)
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
        $scope.sendTx();
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

  $scope.sendTx = function () {
    uiFuncs.sendTx($scope.signedTx, function (resp) {
      if (!resp.isError) {
        $scope.txHash = resp.data;
        var bExStr = $scope.ajaxReq.type != nodes.nodeTypes.Custom ? "<a href='" + $scope.ajaxReq.blockExplorerTX.replace("[[txHash]]", resp.data) + "' target='_blank' rel='noopener'> View your transaction </a>" : '';
        var contractAddr = $scope.tx.contractAddr != '' ? " & Contract Address <a href='" + ajaxReq.blockExplorerAddr.replace('[[address]]', $scope.tx.contractAddr) + "' target='_blank' rel='noopener'>" + $scope.tx.contractAddr + "</a>" : '';
        $scope.notifier.success(globalFuncs.successMsgs[2] + "<br />" + resp.data + "<br />" + bExStr + contractAddr);
      } else {
        $scope.notifier.danger(resp.error);
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

  $scope.initializeMusiconomiDefaults = function () {
    $scope.contract.address = $scope.tokenContract;
    $scope.contract.abi = $scope.tokenContractAbi;
    $scope.initContract();
    $scope.selectFunc(0);
    $scope.tx.to = $scope.contract.address;

    getPaymentDetails($scope.orderId, function(err, result) {
      if (err) {
        $scope.fetchStatus = "failed";
        $scope.fetchPaymentDetailsError = err;
      }
      else {
        $scope.fetchStatus = "success";
        $scope.paymentDetails = result;
        var extraData = $scope.orderId;
        $scope.tx.data = $scope.getTxDataWithValues([$scope.paymentDetails.recipient, $scope.paymentDetails.approveAmountGrains, extraData]);
        $scope.tx.gasLimit = $scope.paymentDetails.requiredGas;
      }
    })
  };
  $scope.initializeMusiconomiDefaults();
};
module.exports = paymentsCtrl;
